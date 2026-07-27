# Prompt: cut PEC's shop time (paste into a fresh session)

Copy everything below the line into a new Claude session. It is self-contained.

---

## Context

I own Prescott Epoxy Company (PEC), an epoxy and concrete coatings contractor in Prescott, Arizona. I have six field employees. We track time in BusyBusy. I just pulled our first real payroll export and found a number I want to attack.

**Week of July 20 to 26, 2026:**

- 320.50 total hours across 6 people
- **145.95 hours (45.5%) logged to a project called "Shop"** with no customer, no project number, no cost code
- 174.55 hours attributed to actual customer jobs, spread across 9 customers (largest 29.5 hours, smallest 4.0)
- **84.78 hours classified as overtime (OT1)** across 17 entries
- Two people were over 65 hours for the week, one over 55, two over 45
- Cost codes are blank on every entry, so "Shop" is the only label distinguishing non-job time

**Current morning process, in my words:** everyone shows up at the shop in the morning to load up, then heads out to the job.

At roughly $25 an hour average, 146 hours a week of shop time is about $3,600 a week, or something like $190,000 a year of labor that no customer is paying for. Some of that is legitimate and unavoidable. I do not believe all of it is.

## What I want from you

Help me figure out how much of that 146 hours is real, then help me cut it. Do not jump to recommendations before the diagnosis. Two of my hypotheses are mutually exclusive and the fix is completely different depending on which is true.

**Hypothesis A, the labeling artifact.** "Shop" is the default project in BusyBusy and crews clock into it in the morning and never switch when they arrive on site. If true, my shop time is largely fiction, my job costing is missing half its labor, and the fix is a BusyBusy configuration change plus a habit, not an operational overhaul. Six people times five hours a day of genuine shop work is not plausible for a coatings crew that is on site most of the day, which is why I lead with this one.

**Hypothesis B, the real load-out.** The hours are real: everyone gathers, loads, mixes, stages, waits on each other, and drives, all on the clock and all charged to Shop. If true, the fix is process: load the night before, stage materials per job, stop having six people watch two people load a truck, meet at the site instead of the shop.

**Hypothesis C, drive time.** Windshield time is being captured as Shop rather than as job time. Prescott to Prescott Valley to Chino Valley is real distance. This changes what "cut it" even means, because drive time is not waste, it is cost of delivery.

## Step 1, run the diagnosis

I have the raw export at `~/bb_week.csv`. It has one row per calculated payroll segment with these columns: `Id, CreatedBy, LastEditedBy, EmployeeId, FirstName, LastName, EmployeePosition, EmployeeGroup, Date, Start, End, Wage, Hours, BreakHours, WageType, Cost, ProjectNumber, Project, CostCode, CostCodeDescription, Equipment, Description` plus subproject and project-location fields. Note that `EmployeeId`, `EmployeeGroup`, and `CostCode` are empty in our data, and `Cost` pays OT at straight time (their bug), so ignore the `Cost` column.

Answer these from the data, not from assumption:

1. **What time of day is Shop time?** For every Shop entry, show start and end times. If Shop blocks run 6:00 to 15:00 continuously, that is Hypothesis A and the diagnosis is over. If they are 6:00 to 7:00 bookends around job time, that is a real load-out.
2. **How many Shop blocks per person per day, and how long is each?** One long block per day reads as a default project. Two short bookends read as load-out plus put-away.
3. **Cross-tabulate WageType against project.** Of the 84.78 OT hours, how many are Shop hours? This is the money question. If overtime is disproportionately shop time, I am paying time and a half for the least productive hours of the week, and cutting shop time is the cheapest overtime reduction available to me.
4. **Per person, what percent of their week was Shop?** If one or two people carry most of it, this is a person or role question (someone is the de facto shop hand) rather than a crew-wide process problem.
5. **Does anyone log Shop time on days they also logged job time, and in what order?** Shop time appearing after the last job block of the day means put-away and equipment cleaning, which is a different fix than morning load.
6. **Read the `Description` field on Shop entries.** People sometimes write what they were doing.

Print a short table for each question. Then tell me which hypothesis the data supports, and say so directly even if it contradicts what I told you about the morning process.

## Step 2, then help me fix it

Once you know which hypothesis holds, work the fix with me. Things I already suspect are levers, but push back on any of them if the data says otherwise, and add what I have missed:

- Loading trucks the evening before rather than the morning of
- Rotating a single person on load-out instead of six people in the same bay
- Pre-kitted materials staged per job (we already generate job cards and material lists in our own system, so the picking list exists)
- Crews meeting at the job site rather than at the shop, where the drive is comparable
- Making BusyBusy require a project selection at clock-in, or removing "Shop" as a selectable default
- Geofencing or a site-arrival prompt so the project switches when the truck arrives
- Splitting "Shop" into real categories (load-out, drive, equipment repair, yard cleanup, training) so next quarter I can see what I am actually buying

For whatever you recommend, tell me: the expected hours saved per week, what could go wrong, and what I would have to give up. I would rather hear "this saves four hours a week, not forty" than an optimistic number.

## Step 3, give me a way to watch it

Propose one weekly number I can put on my ops dashboard that tells me whether this is getting better or worse, defined precisely enough that two people computing it would get the same answer. Shop hours as a percent of total hours is the obvious candidate. Tell me what a realistic target is for a six-person coatings crew, and be honest that you are estimating if you are.

## Ground rules

- Be direct. If my morning-load-out explanation cannot account for 146 hours, say that in the first paragraph.
- Show the arithmetic behind any dollar figure so I can check it.
- Do not recommend software. I have BusyBusy and my own CRM already.
- Do not write me a policy document. I want three changes I can make on Monday, in priority order.
