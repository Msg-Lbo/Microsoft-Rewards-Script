import type { StreakState } from '../../../browser/ReactFunc'

export interface CheckInState {
    status: 'complete' | 'pending' | 'unknown'
    /** 今日剩余可赚的签到积分 */
    remaining: number | null
    /** 今日签到对应的积分额度，与是否已完成无关 */
    todayPoints: number | null
    /** 当前处于连续签到的第几天 */
    currentDay: number | null
    /** 已连续签到天数 */
    completedDays: number | null
    /** 连续签到周期总天数 */
    totalDays: number | null
    reason: string
}

/**
 * 解析移动应用签到状态
 * 唯一依据是新版仪表板的 bingapp 连续打卡模型，旧推广的 last_updated 会被错误上报写脏，不可信
 * @param {StreakState|null} streak - bingapp 连击状态
 * @returns {CheckInState} 签到状态
 */
export function resolveCheckInState(streak: StreakState | null): CheckInState {
    if (!streak) {
        return {
            status: 'unknown',
            remaining: null,
            todayPoints: null,
            currentDay: null,
            completedDays: null,
            totalDays: null,
            reason: '未取得移动应用连续打卡状态'
        }
    }

    const currentDay = streak.currentDay
    const completedDays = streak.completedDays
    const totalDays = streak.totalDays
    const todayPoints = streak.dailyPoints[currentDay] ?? null
    const complete = streak.isCurrentDayCompleted || streak.activitiesCompleted >= streak.activitiesTotal

    return {
        status: complete ? 'complete' : 'pending',
        remaining: complete ? 0 : todayPoints,
        todayPoints,
        currentDay,
        completedDays,
        totalDays,
        reason: complete ? '今日签到已完成' : '今日尚未签到'
    }
}
