import { URLs } from '../../../constants/urls'
import { BaseActivity } from '../BaseActivity'
import type { ParentQuest, QuestChild } from '../../../browser/ReactFunc'
import type { BasePromotion, DashboardData, PunchCard } from '../../../interface/DashboardData'

export class PunchCards extends BaseActivity {
    public async runMobile(data: DashboardData): Promise<void> {
        try {
            await this.run(data)
        } catch (error) {
            this.bot.logger.error(
                'main',
                'PUNCHCARD',
                `移动端打卡任务失败 | ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    public async runDesktop(): Promise<void> {
        if (!this.bot.config.workers.doPunchCards) return

        let data: DashboardData
        try {
            data = await this.bot.browser.func.getDashboardData(this.bot.cookies.desktop)
        } catch (error) {
            this.bot.logger.warn(
                'main',
                'PUNCHCARD',
                `桌面端打卡数据不可用 | ${error instanceof Error ? error.message : String(error)}`
            )
            return
        }

        try {
            await this.run(data)
        } catch (error) {
            this.bot.logger.error(
                'main',
                'PUNCHCARD',
                `桌面端打卡任务失败 | ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private async run(data: DashboardData): Promise<void> {
        const parents = await this.getParentQuests()
        if (!parents) return

        const apiById = new Map(
            (data.dashboard.punchCards ?? [])
                .filter(card => card.parentPromotion?.offerId)
                .map(card => [card.parentPromotion.offerId, card] as const)
        )

        this.mergeApiParents(parents, apiById)
        const pending = parents.filter(parent => {
            if (parent.complete) return false
            return !this.bot.config.skipNonPointTasks || parent.pointProgressMax > 0
        })

        if (!pending.length) {
            this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', '没有可执行的任务')
            return
        }

        this.bot.logger.info(
            this.bot.isMobile,
            'PUNCHCARD',
            `发现 ${pending.length} 个未完成任务 | apiMatched=${pending.filter(parent => apiById.has(parent.offerId)).length}`
        )
        for (const parent of pending) {
            try {
                await this.solvePunchCard(parent, apiById.get(parent.offerId))
            } catch (error) {
                this.bot.logger.error(
                    this.bot.isMobile,
                    'PUNCHCARD',
                    `解决任务 "${parent.title || parent.offerId}" 时出错 | message=${
                        error instanceof Error ? error.message : String(error)
                    }`
                )
            }
        }

        this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', '任务处理完毕')
    }

    private async getParentQuests(): Promise<ParentQuest[] | null> {
        try {
            const earn = await this.bot.browser.func.getRewardsPageHtml(URLs.rewards.earn, '/earn')
            if (!earn) {
                this.bot.logger.warn(this.bot.isMobile, 'PUNCHCARD', '/earn 不可用 - 无法获取任务列表')
                return null
            }

            const parents = this.bot.browser.react.snapshotQuestList(earn)
            if (parents.length) return parents

            const dashboard = await this.bot.browser.func.getRewardsPageHtml(URLs.rewards.dashboard, '/dashboard')
            return dashboard ? this.bot.browser.react.snapshotQuestList(earn, dashboard) : parents
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'PUNCHCARD',
                `获取任务列表失败 | ${error instanceof Error ? error.message : String(error)}`
            )
            return null
        }
    }

    private mergeApiParents(parents: ParentQuest[], apiById: Map<string, PunchCard>): void {
        const seen = new Set(parents.map(parent => parent.offerId))

        for (const card of apiById.values()) {
            const promotion = card.parentPromotion
            if (!promotion?.offerId || seen.has(promotion.offerId)) continue

            parents.push({
                offerId: promotion.offerId,
                title: promotion.title ?? '',
                pointProgressMax: promotion.pointProgressMax ?? 0,
                complete: Boolean(promotion.complete)
            })
            seen.add(promotion.offerId)
        }

        for (const parent of parents) {
            if (parent.pointProgressMax > 0) continue
            parent.pointProgressMax = apiById.get(parent.offerId)?.parentPromotion?.pointProgressMax ?? 0
        }
    }

    private async solvePunchCard(parent: ParentQuest, apiCard: PunchCard | undefined): Promise<void> {
        const parentId = parent.offerId
        const title = parent.title || apiCard?.parentPromotion?.title || parentId
        const children = await this.getQuestChildren(parentId, title)
        if (!children) return

        const apiChildById = new Map(
            (apiCard?.childPromotions ?? [])
                .filter(child => child.offerId)
                .map(child => [child.offerId, child] as const)
        )
        const ordered = [...children].sort(
            (left, right) =>
                (apiChildById.get(left.offerId)?.priority ?? Number.MAX_SAFE_INTEGER) -
                (apiChildById.get(right.offerId)?.priority ?? Number.MAX_SAFE_INTEGER)
        )

        this.bot.logger.info(
            this.bot.isMobile,
            'PUNCHCARD',
            `正在解决 "${title}" | children=${ordered.length} | 可尝试=${ordered.filter(child => child.reportable).length}` +
                ` | 渠道锁=${ordered.filter(child => child.isLocked).length}`
        )

        const startBalance = this.bot.userData.currentPoints
        let reported = 0
        let remaining = 0
        let lockedCredited = false // 渠道专属任务当日已入账，余下留到明天

        for (const child of ordered) {
            const apiChild = apiChildById.get(child.offerId)

            if (!child.reportable) {
                remaining += 1
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'PUNCHCARD',
                    `跳过 ${child.offerId}：不可上报（locked=${child.isLocked} disabled=${child.isDisabled} done=${child.isCompleted} hash=${Boolean(child.hash)}）`
                )
                continue
            }

            // 奖励应用专属等渠道锁只是客户端 UI 限制，服务端照样接受上报，直接放行尝试
            if (child.isLocked) {
                if (lockedCredited) {
                    remaining += 1
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'PUNCHCARD',
                        `"${title}" 今日渠道专属额度已用完，${child.offerId} 留待明天`
                    )
                    continue
                }
                this.bot.logger.info(
                    this.bot.isMobile,
                    'PUNCHCARD',
                    `"${title}" 的 ${child.offerId} 标记为渠道专属（如奖励应用专属），尝试直接上报`
                )
            }

            if (this.isSearchQuotaChild(child.offerId, apiChild)) {
                remaining += 1
                this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', `跳过 ${child.offerId}：多天搜索任务`)
                continue
            }

            if (this.isClaimChild(child.offerId, apiChild)) {
                if (!this.bot.config.autoClaimPunchcardRewards) {
                    remaining += 1
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'PUNCHCARD',
                        `"${title}" 的奖励可手动兑换 | offerId=${child.offerId}`
                    )
                    continue
                }
                if (!(await this.bot.activities.doClaimReward(child, parentId))) {
                    remaining += 1
                    continue
                }
                this.markExecuted()
            } else {
                const outcome = await this.reportQuestChild(child, parentId)
                if (!outcome.ok) {
                    remaining += 1
                    continue
                }
                // 渠道专属任务按天计分：ack 但没进账说明今天额度已满，别继续白跑
                if (child.isLocked) {
                    if (outcome.gained > 0) {
                        lockedCredited = true
                    } else {
                        lockedCredited = true
                        remaining += 1
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'PUNCHCARD',
                            `"${title}" 的 ${child.offerId} 未计入积分，今日渠道专属额度已满，其余留待明天`
                        )
                        continue
                    }
                }
            }

            reported += 1
            await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 15000))
        }

        const gained = this.bot.userData.currentPoints - startBalance
        this.bot.logger.info(
            this.bot.isMobile,
            'PUNCHCARD',
            `任务 "${title}" ${remaining === 0 ? 'COMPLETE' : 'in progress'} | reported=${reported}` +
                `${remaining ? ` | remaining=${remaining}` : ''} | pointsGained=${gained}` +
                ` | currentBalance=${this.bot.userData.currentPoints}` +
                `${parent.pointProgressMax > 0 ? ` | targetPoints=${parent.pointProgressMax}` : ''}`,
            gained > 0 ? 'green' : undefined
        )
    }

    private async getQuestChildren(parentId: string, title: string): Promise<QuestChild[] | null> {
        try {
            const questUrl = URLs.rewards.quest(parentId)
            const html = await this.bot.browser.func.getRewardsPageHtml(questUrl, `/earn/quest/${parentId}`)
            if (!html) {
                this.bot.logger.warn(this.bot.isMobile, 'PUNCHCARD', `"${title}" 的任务页面不可用`)
                return null
            }

            const children = this.bot.browser.react.snapshotQuestPage(html)
            if (!children.length) {
                this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', `"${title}" 没有可执行的子任务`)
                return null
            }
            return children
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'PUNCHCARD',
                `获取 "${title}" 的任务页面失败 | ${error instanceof Error ? error.message : String(error)}`
            )
            return null
        }
    }

    /**
     * 上报单个任务子项
     * @param {QuestChild} child - 子任务
     * @param {String} parentId - 父任务 offerId
     * @returns {Promise<{ok: Boolean, gained: Number}>} ok 表示已发出请求，gained 为实际入账积分
     */
    private async reportQuestChild(child: QuestChild, parentId: string): Promise<{ ok: boolean; gained: number }> {
        const actionId = this.bot.nextActions.reportActivity
        if (!actionId) {
            this.bot.logger.warn(this.bot.isMobile, 'PUNCHCARD', `跳过 ${child.offerId}：未发现 "reportActivity"`)
            return { ok: false, gained: 0 }
        }
        if (!child.hash) {
            this.bot.logger.warn(this.bot.isMobile, 'PUNCHCARD', `跳过 ${child.offerId}：没有有效的 hash`)
            return { ok: false, gained: 0 }
        }

        const oldBalance = this.bot.userData.currentPoints
        let gained = 0
        try {
            const questUrl = URLs.rewards.quest(parentId)
            this.markExecuted()
            const { status, acknowledged } = await this.bot.browser.func.reportServerAction(
                actionId,
                [
                    child.hash,
                    11,
                    {
                        offerid: child.offerId,
                        isPromotional: '$undefined',
                        timezoneOffset: this.bot.userData.timezoneOffset
                    }
                ],
                {
                    url: questUrl,
                    referer: questUrl,
                    routerStateTree: this.bot.browser.react.questRouterStateTree(parentId)
                }
            )

            const newBalance = await this.bot.browser.func.getCurrentPoints()
            gained = newBalance - oldBalance
            if (gained > 0) {
                this.bot.userData.currentPoints = newBalance
                this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gained
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'PUNCHCARD',
                `已上报子任务 | offerId=${child.offerId} | status=${status} | acknowledged=${acknowledged}` +
                    ` | pointsGained=${gained} | currentBalance=${newBalance}`,
                gained > 0 || acknowledged ? 'green' : undefined
            )
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'PUNCHCARD',
                `上报子任务出错 | offerId=${child.offerId} | message=${
                    error instanceof Error ? error.message : String(error)
                }`
            )
            return { ok: false, gained }
        }
        return { ok: true, gained }
    }

    private isSearchQuotaChild(offerId: string, promotion?: BasePromotion): boolean {
        if (promotion) {
            const type = (promotion.promotionType ?? '').toLowerCase()
            const attributeType = String(this.getAttribute(promotion, 'type') ?? '').toLowerCase()
            const progressMax = Number(promotion.activityProgressMax ?? 0)
            if (type === 'search' || attributeType === 'search' || progressMax > 1) return true
        }
        return /search/i.test(offerId) && /(day|streak|\dx)/i.test(offerId)
    }

    private isClaimChild(offerId: string, promotion?: BasePromotion): boolean {
        if (/\/redeem\//.test((promotion?.destinationUrl ?? '').toLowerCase())) return true
        return /(redeem|claim|(?<!url)reward)/i.test(offerId)
    }

    private getAttribute(promotion: BasePromotion, key: string): unknown {
        const attributes = promotion.attributes
        if (!attributes || typeof attributes !== 'object') return undefined
        return (attributes as Record<string, unknown>)[key]
    }
}
