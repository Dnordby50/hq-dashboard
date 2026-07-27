# Prompt: cut PEC's shop time (paste into a fresh session)

Revised 2026-07-27 after a full analysis of the raw export. An earlier version of this prompt led with "146 hours, 45.5% of the week." That number was inflated by one bad punch and has been corrected below. Copy everything under the line into a new Claude session.

---

## Context

I own Prescott Epoxy Company (PEC), an epoxy and concrete coatings contractor in Prescott, Arizona. Six people on the clock, tracked in BusyBusy. I pulled our first real payroll export and want to attack our non-job time.

**Week of Monday July 20 to Friday July 24, 2026** (no weekend work). Total 320.50 hours across 6 people, of which 145.95 hours sit on a project called "Shop" with no customer attached.

**That 145.95 is misleading and I want you to work from the corrected numbers.** One employee, Aron Bronson, has a single continuous punch running from Wednesday 07:52 straight through to Friday 07:39, 47.78 hours unbroken, all on Shop. That is a forgotten clock-out, not work. His whole week (65.80 hours) is on Shop because he is a salesperson with no job to clock into. Removing him entirely:

- **Shop time for the five actual field crew: 80.15 hours, which is 31.5% of their hours.**
- Job-attributed time: 174.55 hours across 9 customer jobs (largest 29.5, smallest 4.0).
- 84.78 hours were classified as overtime that week, and every one of the five crew crossed 40 hours.

**Where the 80 hours actually sits, from the punch times:**

1. **A morning Shop block nearly every day, per person.** Starts between 06:32 and 07:01, runs 45 minutes to 2 hours, ends between 07:35 and 08:30, then they switch to a job. This is the load-up I already knew about. Call it roughly 25 hours a week across the crew.
2. **Whole days on Shop.** Three people spent all of Tuesday 07/21 on Shop (06:39 to 17:50). Davey spent all of Wednesday 07/22. Matthew spent 07/23 on Shop until 13:10. **This is the larger share, roughly 45 to 50 hours, and I do not have a good explanation for it.**
3. Occasional short midday Shop blocks between jobs.

There are no end-of-day Shop returns, so put-away is either not happening on the clock or is being logged to the job.

Only one Shop entry all week carries a description ("Plaza bowl"). Everything else is unlabeled, no cost codes are in use, and sub-projects are unused.

## What I want from you

**Do not start with the morning load-out.** I already know about it and it is the smaller number. Start with the whole-days-on-Shop pattern, which is roughly 60% of the real shop time and which I cannot currently account for.

Work these questions with me in order:

1. **What are three people doing at the shop all day on a Tuesday?** Give me the realistic candidate explanations for a six-person coatings operation: no jobs scheduled that day, weather, waiting on materials, equipment repair, a large mix or prep job, shop buildout, training, or simply no work sold. Tell me what I would look at to distinguish them, including what my own scheduling data would show if the answer is "nothing was booked."
2. **If the answer is "no job was scheduled," this is a sales and scheduling problem wearing a shop-time costume.** In that case the fix is not a faster load-out, it is backlog and dispatch. Say so directly rather than optimizing the wrong thing.
3. **The morning load-out, 45 minutes to 2 hours per person per day.** What is realistic for a crew of five in this trade, and what specifically drives the spread between 45 minutes and 2 hours? Give me the levers ranked by hours saved: loading the night before, one person or a rotating loader instead of the whole crew in the bay, pre-kitted materials per job, crews meeting at the site instead of the shop.
4. **The overtime connection.** All five crew crossed 40 hours, and BusyBusy charges the overtime premium to whatever they happened to be doing when they crossed the line. Roughly a third of the overtime hours that week landed on Shop. Tell me whether cutting shop time is a credible route to cutting the overtime bill, or whether the overtime is simply a volume problem that would exist anyway.
5. **Punch hygiene.** A 47.78-hour unbroken punch made it through the week unnoticed and inflated both my shop time and my overtime. What review step catches that before payroll rather than after, and who should own it? Keep it to something that takes under ten minutes a week.

## Then give me the plan

Three changes I can make on Monday, in priority order. For each: expected hours saved per week, what could go wrong, and what I give up. I would rather hear "this saves four hours a week, not forty."

## And one number to watch

Propose a single weekly metric for my ops dashboard, defined precisely enough that two people computing it would agree. Shop hours as a percentage of crew hours is the obvious candidate, and note that it should exclude non-field staff or it will be meaningless. Tell me a realistic target for a five-person coatings crew, and be explicit that you are estimating if you are.

## Ground rules

- Be direct. If the data says my morning load-out theory is the small half of the problem, lead with that.
- Show the arithmetic behind any dollar figure. Assume roughly $25 an hour average if you need a rate, and say that you assumed it.
- Do not recommend software. I have BusyBusy and my own CRM already.
- No policy documents. Three changes, in order.
