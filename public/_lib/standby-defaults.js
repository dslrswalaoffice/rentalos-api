// Shared, DOM-free helpers for resolving Standby composer defaults from
// workspace.settings. Kept pure so it can be unit-tested in CI (node:test) —
// the New Order Composer imports these and wires them into the DOM.
//
// Configurability rule (RentalOS): standby defaults come from
// workspace.settings.standby_policy, never from hardcoded constants.

/**
 * The workspace-configured default hold duration in minutes, or null when the
 * setting is absent/invalid (caller falls back to its built-in default).
 * @param {any} settings - the workspace.settings object (or null/undefined)
 * @returns {number|null}
 */
export function standbyHoldDefaultMinutes(settings) {
  const v = settings && settings.standby_policy && settings.standby_policy.default_hold_duration_minutes;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Human label for a minute count: "3 hours", "90 min", "1 day", "24 hours".
 * @param {number} mins
 * @returns {string}
 */
export function holdLabel(mins) {
  if (mins % 1440 === 0) { const d = mins / 1440; return d + (d === 1 ? ' day' : ' days'); }
  if (mins % 60 === 0) { const h = mins / 60; return h + (h === 1 ? ' hour' : ' hours'); }
  return mins + ' min';
}
