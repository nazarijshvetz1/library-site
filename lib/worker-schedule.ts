export type ScheduledControllerLike={scheduledTime?:number};

export function scheduledInstant(controller:ScheduledControllerLike|undefined,fallbackMs=Date.now()){
  const scheduledTime=controller?.scheduledTime;
  return new Date(typeof scheduledTime==="number"&&Number.isFinite(scheduledTime)?scheduledTime:fallbackMs);
}

export function isFiveMinuteTick(value:Date){return value.getUTCMinutes()%5===0;}

export function isDailyMemberSyncCleanupTick(value:Date){
  return value.getUTCHours()===1&&value.getUTCMinutes()===17;
}

type HeartbeatDatabase={prepare(sql:string):{bind(...values:string[]):{run():Promise<unknown>}}};

export async function recordScheduledHeartbeat(db:HeartbeatDatabase,scheduledAt:Date,observedAt=new Date()){
  await db.prepare(`INSERT INTO worker_schedule_status(id,scheduled_at,observed_at) VALUES('minute',?,?)
    ON CONFLICT(id) DO UPDATE SET scheduled_at=excluded.scheduled_at,observed_at=excluded.observed_at
    WHERE excluded.scheduled_at>=worker_schedule_status.scheduled_at`).bind(scheduledAt.toISOString(),observedAt.toISOString()).run();
}
