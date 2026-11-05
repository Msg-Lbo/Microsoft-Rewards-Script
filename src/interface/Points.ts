export interface BrowserEarnablePoints {
    desktopSearchPoints: number | null
    mobileSearchPoints: number | null
    dailySetPoints: number
    morePromotionsPoints: number
    totalEarnablePoints: number | null
    mobileSearchMax: number | null
    desktopSearchMax: number | null
    dailySetDone: number
    dailySetTotal: number
    morePromotionsDone: number
    morePromotionsTotal: number
}

export interface AppEarnablePoints {
    readToEarn: number
    checkIn: number | null
    totalEarnablePoints: number | null
    /** 应用推广已完成项数 */
    appPromotionsDone: number
    /** 应用推广总项数 */
    appPromotionsTotal: number
    /** 签到状态，null 表示无法确认 */
    checkInDone: boolean | null
    /** 读文已得积分 */
    readToEarnEarned: number
    /** 读文积分的上限 */
    readToEarnMax: number
    /** 今日签到已得积分 */
    checkInEarned: number | null
    /** 今日签到可得的积分，null 表示无法确认 */
    checkInMax: number | null
    /** 连续签到天数 */
    checkInDays: number | null
    /** 连续签到周期总天数 */
    checkInTotalDays: number | null
}

/** 单项积分来源的进度，用于日志与仪表板统一展示 */
export interface PointProgress {
    /** 来源名称，同时作为日志键名 */
    label: string
    /** 已获得 */
    earned: number
    /** 上限；null 表示该账户没有这项任务 */
    max: number | null
    /** 计量单位：分 / 项 / 次 / 分钟 */
    unit: string
    /** 是否已完成；null 表示无法确认 */
    done: boolean | null
    /** 附加说明，例如连续签到天数 */
    detail?: string
}

export interface MissingSearchPoints {
    mobilePoints: number
    desktopPoints: number
    edgePoints: number
    totalPoints: number
}
