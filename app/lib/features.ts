// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// The features a camp can switch on and off (R20), and the pages each one owns. Stewards Sale
// ticket requests and announcements are always on. Switching a feature off hides its pages
// (they answer 404), its navigation and its emails; its data stays.

export type FeatureKey = "dues" | "join" | "yearbook" | "saps" | "volunteer" | "mailing";

export type Features = Record<FeatureKey, boolean>;

export const FEATURES: Array<{
  key: FeatureKey;
  label: string;
  description: string;
  // New camps: dues, the join page and the Yearbook on; the rest off.
  defaultOn: boolean;
  paths: string[];
}> = [
  {
    key: "dues",
    label: "Dues",
    description: "The Treasurer records who has paid. The app never takes payments.",
    defaultOn: true,
    paths: ["/dues"],
  },
  {
    key: "join",
    label: "Join page and inquiries",
    description: "A public page where people can say they're interested, and the Leads' pipeline.",
    defaultOn: true,
    paths: ["/join", "/inquiries"],
  },
  {
    key: "yearbook",
    label: "Yearbook and directory",
    description: "Photo cards for this year and past years, and the contact directory.",
    defaultOn: true,
    paths: ["/yearbook"],
  },
  {
    key: "saps",
    label: "Setup Access Passes",
    description: "Early-arrival requests, Lead decisions, and the passes Burning Man allocates.",
    defaultOn: false,
    paths: ["/saps", "/admin/saps"],
  },
  {
    key: "volunteer",
    label: "Jobs",
    description:
      "The camp's jobs, from Camp lead to Kitchen: some members sign up for, some Leads assign.",
    defaultOn: false,
    paths: ["/volunteer", "/volunteers"],
  },
  {
    key: "mailing",
    label: "Mailing addresses",
    description:
      "Campers can add a postal address on their profile. Only Leads and Admins see it, and it's in the spreadsheet export.",
    defaultOn: false,
    paths: [],
  },
];

// The feature that owns a path, if any: the path itself or anything below it.
export function featureForPath(path: string): FeatureKey | null {
  for (const f of FEATURES) {
    if (f.paths.some((p) => path === p || path.startsWith(`${p}/`))) return f.key;
  }
  return null;
}
