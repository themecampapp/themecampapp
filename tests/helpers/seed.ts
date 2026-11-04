// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { drizzle } from "drizzle-orm/postgres-js";
import { burn, camp, campSettings, volunteerRole } from "~/db/schema";

// Every test database gets one camp, set up the way Yellow Balloon's was: seasons 2024 to 2027
// with 2027 current, 2027's SAP days, and its jobs: the elected ones (Leads fill them, and they
// show in the Yearbook's Who's who, as positions did before issue #106) and the sign-up ones. Its id is
// fixed so request contexts can name it without a lookup; tests add more camps as needed.
export const TEST_CAMP_SLUG = "testcamp";
export const TEST_CAMP_ID = "00000000-0000-4000-8000-000000000001";

// biome-ignore lint/suspicious/noExplicitAny: the helper works with any schema-typed drizzle db
export async function seedDefaultCamp(db: ReturnType<typeof drizzle<any>>) {
  const [c] = await db
    .insert(camp)
    .values({ id: TEST_CAMP_ID, slug: TEST_CAMP_SLUG, name: "Test Camp" })
    .returning();
  await db.insert(burn).values([
    { campId: c.id, year: 2024 },
    { campId: c.id, year: 2025 },
    { campId: c.id, year: 2026 },
    {
      campId: c.id,
      year: 2027,
      sapDays: ["2027-08-24", "2027-08-25", "2027-08-26", "2027-08-27", "2027-08-28"],
    },
  ]);
  // After the seasons: the current year must be one of the camp's seasons.
  // Yellow Balloon used every feature, and the carried-over tests exercise them all.
  await db.insert(campSettings).values({
    campId: c.id,
    currentYear: 2027,
    featureSaps: true,
    featureVolunteer: true,
    inquiryNotify: ["leads@example.com"],
  });
  const titles = [
    "Main camp lead",
    "Events coordinator",
    "Treasurer",
    "Newcomer liaison",
    "Communication",
    "Social/fun chair",
    "Creativity director",
    "Decor",
  ];
  await db.insert(volunteerRole).values(
    titles.map((title, i) => ({
      campId: c.id,
      title,
      slots: 2,
      selfSignup: false,
      showInYearbook: true,
      sort: (i + 1) * 10 - 10000,
    })),
  );
  await db.insert(volunteerRole).values(VOLUNTEER_ROLES.map((r) => ({ campId: c.id, ...r })));
  return c;
}

const VOLUNTEER_ROLES = [
  {
    title: "Volunteer Coordinator",
    commitment: "2–5 hrs a week before the burn",
    description:
      "Advertise open volunteer positions and fill vacant ones, share each role's duties (and connect people with someone experienced who had the job before, if needed), and make sure teams know they're working together.",
    slots: 1,
    sort: 10,
  },
  {
    title: "Logistics/Infrastructure Lead",
    commitment: "3–5 hrs a month, and 10–15 hrs during build week",
    description:
      "Point person for inventory, storage, build and strike. Ideally able to show up early; may be the first person at camp. Organizes subcommittee meetings for infrastructure prep.",
    slots: 1,
    sort: 20,
  },
  {
    title: "Camp Cartographer",
    commitment: "5–10 hrs before the burn",
    description:
      "Make the camp layout for all the main camp structures, artwork, bike racks, shipping container and so on (everything except people's homes and cars). Work with quad leads to get them up to speed on the main layout so they can lay out people in their quads from there.",
    slots: 1,
    sort: 30,
  },
  {
    title: "Build Lead (on-playa)",
    commitment: "Some pre-planning, and 20+ hrs during build week",
    description:
      "Point person for the build team. Must be able to show up by Tuesday of build week; may be the first person at camp.",
    slots: 1,
    sort: 40,
  },
  {
    title: "Camp build organizer",
    commitment: "18+ hrs during build week",
    description: "Leads a crew during build week. Must be able to show up early.",
    slots: 5,
    sort: 50,
  },
  {
    title: "Breakdown Lead",
    commitment: "3–5 hrs a month before the burn, and 10–15 hrs at the end",
    description:
      "Point person for the breakdown team. Must be able to stay through Monday; may be the last person at camp.",
    slots: 1,
    sort: 60,
  },
  {
    title: "Camp breakdown organizer",
    commitment: "10–15 hrs at the end of the burn",
    description: "Leads a crew during breakdown. Must be able to stay through Monday.",
    slots: 2,
    sort: 70,
  },
  {
    title: "MOOP Lead",
    commitment: "10–15 hrs at the end of the burn",
    description:
      "Leads MOOP sweeps after breakdown is complete. Must be able to stay through Monday.",
    slots: 1,
    sort: 80,
  },
  {
    title: "Camp decor",
    commitment: "3–5 hrs a month, and 10–15 hrs during the burn",
    description:
      "Encourage campers to make art and bring interactive elements, and imagine how to make the camp frontage more inviting and dynamic.",
    slots: 2,
    sort: 90,
  },
  {
    title: "12 Step/Recovery Meeting Coordinator",
    commitment: "2–3 hrs a month before the burn",
    description:
      "Coordinates YB's 12-step meeting schedule, works with Anonymous Village's interplaya rep, and updates meeting literature.",
    slots: 1,
    sort: 100,
  },
  {
    title: "Consent person/Beducator",
    commitment: null,
    description:
      "Bureau of Erotic Discourse rep: holds a session on sex-positive consent education.",
    slots: 1,
    sort: 110,
  },
  {
    title: "Sustainability Liaison",
    commitment: null,
    description: "Coordinates with the Org and other camps about sustainability.",
    slots: 1,
    sort: 120,
  },
];
