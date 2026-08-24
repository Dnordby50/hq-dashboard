-- @artifacts
--   setting: pricing_instant_touch_delay_minutes
-- @end
-- ============================================================================
-- 2026-09-16: Instant Pricing, delay the day-0 instant reply (Dylan,
-- 2026-08-24: "delay the instant thanks for reaching out by 10 minutes").
-- Author: Claude Code. Direct to prod per rule 14 (settings seed only).
--
-- WHY: the pricing funnel flows straight into booking, and the inline
-- instant text was landing while the visitor was still picking a slot.
-- With a delay, pec-pricing enrolls the lead with next_send_at pushed
-- <delay> minutes out and skips the inline send; the 15-minute drip runner
-- delivers it once due (so the real-world delay is delay-to-delay+15, and
-- quiet hours now apply, which the inline path bypassed). If the visitor
-- books inside the window, apptBookingLeadEffects pauses the enrollment and
-- the text never sends; the booking confirmation covers them instead.
-- '0' restores the inline immediate send. Webform intake (pec-lead-intake)
-- is untouched: those leads are not mid-booking, immediate is right there.
-- ============================================================================

insert into public.settings (key, value) values
  ('pricing_instant_touch_delay_minutes', '10')
on conflict (key) do nothing;
