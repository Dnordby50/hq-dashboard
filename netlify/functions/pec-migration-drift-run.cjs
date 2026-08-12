// HTTP alias for the scheduled pec-migration-drift (prompt 90 Task A find):
// Netlify refuses direct HTTP invocation of any schedule-declared function
// with an empty 403 (verified live 2026-08-12), which means the Ops Queue's
// and the Schema Drift panel's ?manual=1 fetches of pec-migration-drift had
// been dead, silently rendering "check unavailable". This file is NOT in
// netlify.toml's schedule list, so it accepts HTTP; it delegates straight to
// the same handler, whose own requireStaff gate on the manual path still
// applies unchanged.

exports.handler = require('./pec-migration-drift.cjs').handler;
