'use strict';

// ---- service schedule check -----------------------------------
// M-11 fix (2026-10-15): evaluated in Asia/Dhaka (was server-local TZ).
// schedule.days uses JS numbering: 0=Sunday … 6=Saturday.
function serviceOpen(schedule) {
  if (!schedule || (!schedule.open && !schedule.close)) return true;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Dhaka', weekday: 'short', hour: '2-digit', minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date());
    const get = (t) => (parts.find((p) => p.type === t) || {}).value;
    const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[get('weekday')];
    if (Array.isArray(schedule.days) && schedule.days.length && !schedule.days.includes(wd)) {
      return false;
    }
    const hhmm = get('hour') + ':' + get('minute');
    if (schedule.open && hhmm < schedule.open) return false;
    if (schedule.close && hhmm > schedule.close) return false;
    return true;
  } catch (e) { return true; }
}

function isManualOrderService(service) {
  return service.type === 'manual' && !String(service.engine_id || '').trim();
}

function serviceAcceptsNewWork(service) {
  const override = service.schedule?.order_intake_open;
  if (isManualOrderService(service) && typeof override === 'boolean') return override;
  return serviceOpen(service.schedule);
}

module.exports = { isManualOrderService, serviceAcceptsNewWork };
