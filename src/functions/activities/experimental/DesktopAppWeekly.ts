import { URLs } from '../../../constants/urls'
import type { QuestChild } from '../../../browser/ReactFunc'
import { BaseActivity } from '../BaseActivity'

const LOG_TAG = 'DESKTOP-APP'

// Weekly punchcard that only the Windows Rewards (Bing) desktop app shows.
const WEEKLY_PARENT_PATTERN = /\/earn\/quest\/([A-Za-z0-9_]*RewardsApp_weekly[A-Za-z0-9_]*)/gi

// The desktop client identifies itself with these headers; the weekly exclusive tasks are
// only signed (and only claimable) for that client, even though everything runs over HTTP.
const DESKTOP_APP_HEADERS: Record<string, string> = {
    'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) MSRewards/Desktop/1.4.56',
    'X-MSRewards-App': '1',
    'X-Rewards-Source': 'msrewards-desktop'
}

const ACTIVITY_TYPE = 11
const CLAIM_DELAY_MIN_MS = 1500
const CLAIM_DELAY_MAX_MS = 3500

export class DesktopAppWeekly extends BaseActivity {
    public async run(signal?: AbortSignal): Promise<void> {
        try {
            const earnHtml = await this.bot.browser.func.getRewardsPageHtml(URLs.rewards.earn, '/earn')
            if (!earnHtml) {
                this.bot.logger.warn(this.bot.isMobile, LOG_TAG, '跳过：无法获取 /earn 页面')
                return
            }

            const parents = [...new Set([...earnHtml.matchAll(WEEKLY_PARENT_PATTERN)].map(m => m[1]!))]
            if (!parents.length) {
                this.bot.logger.info(this.bot.isMobile, LOG_TAG, '本周没有桌面奖励应用专属任务')
                return
            }

            this.bot.logger.info(
                this.bot.isMobile,
                LOG_TAG,
                `发现桌面应用专属任务 | 周卡=${parents.length} | ${parents.join(', ')}`
            )

            for (const parentId of parents) {
                if (signal?.aborted) return
                await this.handleParent(parentId, signal)
            }
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                LOG_TAG,
                `桌面应用专属任务处理失败 | ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private async handleParent(parentId: string, signal?: AbortSignal): Promise<void> {
        const questUrl = URLs.rewards.quest(parentId)
        const before = await this.fetchChildren(questUrl, parentId)
        if (!before.length) {
            this.bot.logger.warn(this.bot.isMobile, LOG_TAG, `未能解析任务子项 | parent=${parentId}`)
            return
        }

        // Channel locks (「奖励应用专属」/ 未解锁的星期) only gate the client entry point; the server
        // still signs a hash, so report them the same way other locked punchcards are handled here.
        const pending = before.filter(child => !!child.hash && !child.isCompleted && !child.isDisabled)
        const done = before.filter(child => child.isCompleted).length
        const locked = before.filter(child => child.isLocked && !child.isCompleted).length
        this.bot.logger.info(
            this.bot.isMobile,
            LOG_TAG,
            `任务状态 | parent=${parentId} | 已完成=${done}/${before.length} | 待上报=${pending.length} | 其中未解锁=${locked}`
        )

        if (!pending.length) return

        const actionId = this.bot.nextActions.reportActivity
        if (!actionId) {
            this.bot.logger.warn(this.bot.isMobile, LOG_TAG, `跳过：bundle 中未发现 "reportActivity"`)
            return
        }

        let claimed = 0
        for (const child of pending) {
            if (signal?.aborted) return
            if (await this.claim(child, parentId, actionId)) claimed++
            await this.sleep(CLAIM_DELAY_MIN_MS, CLAIM_DELAY_MAX_MS)
        }

        const after = await this.fetchChildren(questUrl, parentId)
        const total = after.length || before.length
        const remaining = after.filter(child => !child.isCompleted && !child.isDisabled).length
        const completed = total - remaining
        this.bot.logger.info(
            this.bot.isMobile,
            LOG_TAG,
            `桌面应用专属任务完成情况 | 本次领取=${claimed}/${pending.length} | 已完成=${completed}/${total}`,
            claimed > 0 ? 'green' : undefined
        )
    }

    private async fetchChildren(questUrl: string, parentId: string): Promise<QuestChild[]> {
        const html = await this.bot.browser.func.fetchRewardsPageHtml(
            questUrl,
            `/earn/quest/${parentId}`,
            DESKTOP_APP_HEADERS
        )
        if (!html) return []
        return this.bot.browser.react.snapshotQuestPage(html)
    }

    private async claim(child: QuestChild, parentId: string, actionId: string): Promise<boolean> {
        const hash = child.hash
        if (!hash) return false

        const body = [
            hash,
            ACTIVITY_TYPE,
            {
                offerid: child.offerId,
                isPromotional: '$undefined',
                timezoneOffset: this.bot.userData.timezoneOffset
            }
        ]

        const questUrl = URLs.rewards.quest(parentId)
        this.markExecuted()

        let result = await this.bot.browser.func.reportServerAction(actionId, body, {
            url: questUrl,
            referer: questUrl,
            routerStateTree: this.bot.browser.react.questRouterStateTree(parentId),
            headers: DESKTOP_APP_HEADERS
        })

        // The desktop app reports from /earn; keep that as a fallback if the quest route is rejected.
        if (!result.acknowledged) {
            result = await this.bot.browser.func.reportServerAction(actionId, body, {
                url: URLs.rewards.earn,
                referer: URLs.rewards.earn,
                routerStateTree: this.bot.browser.react.routerStateTree('earn'),
                headers: DESKTOP_APP_HEADERS
            })
        }

        if (result.availablePoints !== null) this.bot.userData.currentPoints = result.availablePoints

        if (result.acknowledged) {
            this.bot.logger.info(
                this.bot.isMobile,
                LOG_TAG,
                `已上报 | offerId=${child.offerId} | status=${result.status}`
            )
        } else {
            this.bot.logger.warn(
                this.bot.isMobile,
                LOG_TAG,
                `上报未被确认 | offerId=${child.offerId} | status=${result.status}`
            )
        }

        return result.acknowledged
    }

    private async sleep(minMs: number, maxMs: number): Promise<void> {
        const ms = minMs + Math.floor(Math.random() * (maxMs - minMs + 1))
        await new Promise(resolve => setTimeout(resolve, ms))
    }
}
