// Fixture test for the Zapier Google review intake (prompt 60, Parts E + I).
// Drives the REAL processReviewIntake from pec-review-intake.cjs against the
// shared mini-PostgREST harness. Run: node production/review-intake.test.cjs
'use strict';
const { processReviewIntake, readReviewFields, parseRating, nameScore, crewMentioned } = require('../netlify/functions/pec-review-intake.cjs');
const { makeDb, makeChecker } = require('./_drip-test-kit.cjs');

const { state, ok } = makeChecker();
const NOW = new Date('2026-07-20T17:00:00Z');
const deps = fx => ({ sb: fx.sb, logIngest: async () => {}, now: () => NOW });

function tables(over = {}) {
  return {
    settings: [
      { id: 's1', key: 'review_match_window_days', value: '45' },
      { id: 's2', key: 'review_alert_max_stars', value: '3' },
    ],
    reviews: [],
    pec_review_requests: [{
      id: 'req1', job_id: 'job1', prod_job_id: 'prod1', customer_id: 'cust1',
      token: 'tok-rev-1', status: 'asked', crew_lead: 'Kyle Smith', crew_id: 'crew1',
      brand: 'epoxy', asked_at: '2026-07-15T16:00:00Z', first_clicked_at: null,
      click_count: 0, review_id: null, stop_reason: null, created_at: '2026-07-15T16:00:00Z',
    }],
    customers: [
      { id: 'cust1', name: 'Bob Builder', first_name: 'Bob', last_name: 'Builder' },
      { id: 'cust2', name: 'Ann Ash', first_name: 'Ann', last_name: 'Ash' },
    ],
    pec_notifications: [],
    pec_drip_campaigns: [{ id: 'campR', name: 'Review request', kind: 'review', status: 'active', mode: 'live', max_touches: 4 }],
    pec_drip_enrollments: [{
      id: 'enrR', subject_type: 'job', subject_id: 'job1', lead_id: null,
      campaign_id: 'campR', status: 'active', next_step_index: 1,
      next_send_at: '2026-07-22T16:00:00Z', enrolled_at: '2026-07-15T16:00:00Z',
      stop_reason: null, stopped_at: null,
    }],
    ...over,
  };
}

// The raw Google Business Profile resource shape Zapier commonly forwards:
// nested reviewer.displayName, starRating as a WORD, createTime, reviewId.
const GBP_PAYLOAD = {
  reviewId: 'g-rev-1',
  name: 'accounts/1/locations/2/reviews/g-rev-1',
  reviewer: { displayName: 'Bob Builder' },
  starRating: 'FIVE',
  comment: 'Kyle and the crew were awesome, garage looks brand new.',
  createTime: '2026-07-20T15:00:00Z',
};

(async () => {
  console.log('# defensive field reading (the Routemize lesson)');
  {
    ok(parseRating('FIVE') === 5 && parseRating('two') === 2 && parseRating(4) === 4 && parseRating('3 stars') === 3 && parseRating('great') === null, 'starRating words, numbers, and "N stars" all parse; garbage is null');
    const f = readReviewFields(GBP_PAYLOAD);
    ok(f.rating === 5 && f.reviewerName === 'Bob Builder' && f.externalId === 'g-rev-1' && f.reviewText.includes('Kyle'), 'nested reviewer.displayName + word rating + reviewId are read');
    const flat = readReviewFields({ review_id: 'x1', reviewer_name: 'Ann Ash', rating: '4', review_text: 'nice', posted_at: '2026-07-19' });
    ok(flat.rating === 4 && flat.reviewerName === 'Ann Ash' && flat.externalId === 'x1', 'the flattened snake_case vocabulary reads too');
    const noId = readReviewFields({ reviewer_name: 'Ann Ash', rating: 5, review_text: 'hey', posted_at: '2026-07-19' });
    ok(noId.externalId && noId.externalId.startsWith('gbp-synth:'), 'a payload with no review id gets a DETERMINISTIC synthetic id (re-fires still dedupe)');
    ok(readReviewFields({ reviewer_name: 'Ann Ash', rating: 5, review_text: 'hey', posted_at: '2026-07-19' }).externalId === noId.externalId, 'the synthetic id is stable across identical payloads');
  }

  console.log('# name scoring: similarity, never identity');
  {
    ok(nameScore('Bob Builder', 'Bob Builder') === 3 && nameScore('Bob B.', 'Bob Builder') === 2 && nameScore('Bob', 'Bob Builder') === 1, 'exact 3, first+last-initial 2, first-only 1');
    ok(nameScore('Bob Jones', 'Bob Builder') === 0, 'a CONTRADICTING last initial scores zero (different person, not a weaker match)');
    ok(crewMentioned('Kyle did a great job', 'Kyle Smith') && !crewMentioned('great job all around', 'Kyle Smith'), 'crew-leader first-name mention detection');
  }

  console.log('# auto-match: one clear candidate');
  {
    const fx = makeDb(tables());
    const out = await processReviewIntake(deps(fx), GBP_PAYLOAD);
    ok(out.status === 200 && out.body.created && out.body.match_status === 'auto' && out.body.job_id === 'job1', 'a clear single candidate auto-matches');
    const rv = fx.db.reviews[0];
    ok(rv.match_status === 'auto' && rv.job_id === 'job1' && rv.customer_id === 'cust1' && rv.review_request_id === 'req1', 'review row is linked to the job, customer, and request');
    ok(rv.crew_lead === 'Kyle Smith' && rv.crew_id === 'crew1', 'crew attribution comes from the ask-time SNAPSHOT, never re-derived');
    const req = fx.db.pec_review_requests[0];
    ok(req.status === 'reviewed' && req.review_id === rv.id, 'the ask moves to reviewed and points at the review');
    ok(fx.db.pec_drip_enrollments[0].status === 'stopped' && fx.db.pec_drip_enrollments[0].stop_reason === 'reviewed', 'the live drip stops eagerly with reason reviewed');
    ok(fx.db.pec_notifications.length === 0, 'a 5-star review raises no alert');
    ok(fx.db.reviews.every(r => r.match_status !== 'confirmed'), 'THE INVARIANT: the intake never writes confirmed (only a human does)');
  }

  console.log('# ambiguity stays unmatched (guessing pays the wrong crew leader)');
  {
    const fx = makeDb(tables({
      pec_review_requests: [
        { id: 'req1', job_id: 'job1', customer_id: 'cust1', status: 'asked', asked_at: '2026-07-15T16:00:00Z', crew_lead: 'Kyle Smith', crew_id: null, prod_job_id: null, first_clicked_at: null, review_id: null, created_at: '2026-07-15T16:00:00Z' },
        { id: 'req2', job_id: 'job2', customer_id: 'cust3', status: 'asked', asked_at: '2026-07-16T16:00:00Z', crew_lead: 'Dane Frost', crew_id: null, prod_job_id: null, first_clicked_at: null, review_id: null, created_at: '2026-07-16T16:00:00Z' },
      ],
      customers: [
        { id: 'cust1', name: 'Bob Builder', first_name: 'Bob', last_name: 'Builder' },
        { id: 'cust3', name: 'Bob Builder', first_name: 'Bob', last_name: 'Builder' },
      ],
    }));
    const out = await processReviewIntake(deps(fx), { ...GBP_PAYLOAD, comment: 'Great work.' });
    ok(out.body.match_status === 'unmatched' && out.body.job_id === null, 'two equally-plausible candidates tie: unmatched, a human sorts it out');
    const rv = fx.db.reviews[0];
    ok(rv.job_id == null && rv.match_status === 'unmatched', 'review row is recorded with job_id null (the NOT NULL drop earning its keep)');
    ok(fx.db.pec_review_requests.every(r => r.status === 'asked' && r.review_id == null), 'no request is touched on an ambiguous match');
  }

  console.log('# no name evidence: recorded, unmatched');
  {
    const fx = makeDb(tables());
    const out = await processReviewIntake(deps(fx), { ...GBP_PAYLOAD, reviewId: 'g-rev-9', reviewer: { displayName: 'Zed Zeppelin' } });
    ok(out.body.created && out.body.match_status === 'unmatched', 'an unrecognizable reviewer inserts unmatched');
  }

  console.log('# idempotency on external_id (Zapier re-fires)');
  {
    const fx = makeDb(tables());
    await processReviewIntake(deps(fx), GBP_PAYLOAD);
    const out2 = await processReviewIntake(deps(fx), { ...GBP_PAYLOAD, comment: 'Kyle and the crew were awesome, garage looks brand new. Edited.' });
    ok(out2.body.updated === true && fx.db.reviews.length === 1, 're-posting the same external_id updates in place, never a second row');
    ok(fx.db.reviews[0].review_text.includes('Edited'), 'the re-fire refreshed the text');
    ok(fx.db.reviews[0].match_status === 'auto' && fx.db.reviews[0].job_id === 'job1', 'the existing match is never disturbed by a re-fire');
  }

  console.log('# unparseable payloads answer 200 with a note (no retry storm)');
  {
    const fx = makeDb(tables());
    const out = await processReviewIntake(deps(fx), { hello: 'world' });
    ok(out.status === 200 && out.body.recorded === false && /rating/.test(out.body.note), 'no readable rating: 200 + human-readable note, nothing recorded');
    ok(fx.db.reviews.length === 0, 'no row was inserted');
  }

  console.log('# bad-review alerting (Part I)');
  {
    const fx = makeDb(tables());
    const payload = { ...GBP_PAYLOAD, reviewId: 'g-rev-2', starRating: 'TWO', comment: 'Kyle was late and the floor bubbled.' };
    const out = await processReviewIntake(deps(fx), payload);
    ok(out.body.alerted === true, 'a 2-star review raises the alert');
    const bell = fx.db.pec_notifications[0];
    ok(bell && bell.type === 'bad_review' && bell.target_view === 'reviews' && /2-star/.test(bell.body) && /Bob Builder/.test(bell.body), 'one bell, titled with stars + the matched customer name, clickable to Reviews');
    ok(fx.db.pec_drip_enrollments[0].status === 'stopped' && fx.db.pec_drip_enrollments[0].stop_reason === 'bad_review', 'the live enrollment stops with stop_reason bad_review');
    const again = await processReviewIntake(deps(fx), payload);
    ok(again.body.updated === true && fx.db.pec_notifications.length === 1, 'a re-fire of the same external_id NEVER re-alerts (retry storm != notification storm)');
  }
  {
    // Unmatched bad review still alerts: not knowing whose job it was is
    // exactly when a human needs to go look.
    const fx = makeDb(tables());
    const out = await processReviewIntake(deps(fx), { reviewId: 'g-rev-3', reviewer: { displayName: 'Unknown Stranger' }, starRating: 'ONE', comment: 'terrible' });
    ok(out.body.alerted === true && out.body.match_status === 'unmatched', 'an unmatched 1-star review still alerts');
    ok(/Unknown Stranger/.test(fx.db.pec_notifications[0].body) && /not matched/.test(fx.db.pec_notifications[0].body), 'the bell names the reviewer and says it is unmatched');
  }
  {
    // The threshold is a settings knob (rule 12).
    const fx = makeDb(tables());
    fx.db.settings.find(s => s.key === 'review_alert_max_stars').value = '2';
    const out = await processReviewIntake(deps(fx), { ...GBP_PAYLOAD, reviewId: 'g-rev-4', starRating: 'THREE' });
    ok(out.body.alerted === false && fx.db.pec_notifications.length === 0, 'a 3-star review does not alert when the threshold is 2');
  }

  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  process.exit(state.failed ? 1 : 0);
})().catch(err => { console.error('fixture crashed:', err); process.exit(1); });
