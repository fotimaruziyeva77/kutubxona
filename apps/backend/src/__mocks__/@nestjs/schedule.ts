/** @nestjs/schedule mock — Jest testlar uchun */
export const Cron = (_expression: string) =>
  (_target: unknown, _key: string, _descriptor: PropertyDescriptor) => _descriptor;

export const CronExpression = {
  EVERY_DAY_AT_3AM:     "0 3 * * *",
  EVERY_DAY_AT_MIDNIGHT: "0 0 * * *",
  EVERY_WEEK:           "0 0 * * 0",
  EVERY_1ST_DAY_OF_MONTH_AT_MIDNIGHT: "0 0 1 * *",
};

export const SchedulerRegistry = jest.fn();
export const InjectSchedule    = jest.fn();
