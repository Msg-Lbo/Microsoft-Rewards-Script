import { URLs } from '../../../constants/urls'
import { BING_APP_USER_AGENT } from '../../../constants/userAgents'
import type { HttpRequestConfig } from '../../../util/Http'
import { randomUUID } from 'crypto'
import { BaseActivity } from '../BaseActivity'
import { resolveCheckInState, type CheckInState } from './CheckInState'

export class DailyCheckIn extends BaseActivity {
    private gainedPoints: number = 0

    private oldBalance: number = this.bot.userData.currentPoints

    public async doDailyCheckIn(): Promise<boolean> {
        if (!this.bot.accessToken) {
            this.bot.logger.warn(this.bot.isMobile, 'DAILY-CHECK-IN', '跳过：应用访问令牌不可用，此活动需要它！')
            return false
        }

        this.oldBalance = Number(this.bot.userData.currentPoints ?? 0)
        const before = await this.getCheckInState()
        if (before.status === 'complete') {
            this.bot.logger.info(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `今日已签到，跳过重复请求 | 连签=${before.completedDays}天 | currentBalance=${this.oldBalance}`
            )
            return false
        }

        this.bot.logger.info(
            this.bot.isMobile,
            'DAILY-CHECK-IN',
            `开始每日签到 | geo=${this.bot.userData.geoLocale} | currentBalance=${this.oldBalance} | state=${before.status} | expected=${before.remaining ?? '未知'}`
        )
        this.markExecuted()

        try {
            const response = await this.submitDaily()
            if (
                response.status < 200 ||
                response.status >= 300 ||
                (response.data?.code !== undefined && response.data.code !== 0)
            ) {
                throw new Error(
                    `签到接口未确认成功 | status=${response.status} | code=${response.data?.code ?? 'unknown'}`
                )
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `已收到每日签到响应 | status=${response?.status ?? 'unknown'}`
            )

            const responseBalance = response.data?.response?.balance
            const newBalance =
                typeof responseBalance === 'number' && Number.isFinite(responseBalance)
                    ? responseBalance
                    : await this.bot.browser.func.getCurrentPoints()
            if (!Number.isFinite(newBalance) || newBalance < 0) throw new Error('无法取得有效余额，签到到账状态未知')
            this.gainedPoints = newBalance - this.oldBalance

            this.bot.logger.debug(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `每日签到后的积分变化 | type=103 | previousBalance=${this.oldBalance} | currentBalance=${newBalance} | pointsGained=${this.gainedPoints}`
            )

            if (this.gainedPoints > 0) {
                this.bot.userData.currentPoints = newBalance
                this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + this.gainedPoints

                this.bot.logger.info(
                    this.bot.isMobile,
                    'DAILY-CHECK-IN',
                    `每日签到完成 | type=103 | pointsGained=${this.gainedPoints} | currentBalance=${newBalance}`,
                    'green'
                )
            } else {
                const after = await this.getCheckInState()
                if (after.status !== 'complete') {
                    throw new Error(
                        `签到未确认到账 | pointsGained=${this.gainedPoints} | currentBalance=${newBalance} | state=${after.status}`
                    )
                }
                this.bot.logger.info(
                    this.bot.isMobile,
                    'DAILY-CHECK-IN',
                    `已确认今日签到，本次无新增积分 | pointsGained=0 | currentBalance=${newBalance} | 连签=${after.completedDays}天`
                )
            }
            return true
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `每日签到出错 | message=${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    private async getCheckInState(): Promise<CheckInState> {
        try {
            const streak = await this.bot.browser.func.getStreak('bingapp')
            return resolveCheckInState(streak)
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `签到状态读取失败 | ${error instanceof Error ? error.message : String(error)}`
            )
            return resolveCheckInState(null)
        }
    }

    private async submitDaily() {
        try {
            const jsonData = {
                amount: 1,
                id: randomUUID(),
                type: 103,
                country: this.bot.userData.geoLocale,
                channel: 'SAAndroid',
                attributes: {
                    offerid: 'Gamification_Sapphire_DailyCheckIn'
                }
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `正在准备每日签到载荷 | type=${jsonData.type} | offerid=${jsonData.attributes.offerid} | id=${jsonData.id} | country=${jsonData.country}`
            )

            const request: HttpRequestConfig = {
                url: URLs.platform.activities,
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.bot.accessToken}`,
                    'Content-Type': 'application/json',
                    Accept: '*/*',
                    'User-Agent': BING_APP_USER_AGENT,
                    'X-Rewards-AppId': 'SAAndroid/32.6.2110003560',
                    // partnerId 与 flights 缺一不可：缺失时接口返回 200 但 p=0，新版连续打卡不记账
                    'X-Rewards-PartnerId': 'startapp',
                    'X-Rewards-Flights': 'rwgobig',
                    'X-Rewards-Country': this.bot.userData.geoLocale,
                    'X-Rewards-Language': this.bot.userData.langCode,
                    'X-Rewards-ismobile': 'true'
                },
                data: JSON.stringify(jsonData)
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `正在发送每日签到请求 | type=${jsonData.type} | url=${request.url}`
            )

            return this.bot.http.request<{ code?: number; response?: { balance?: number } }>(request)
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `submitDaily 出错 | message=${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }
}
