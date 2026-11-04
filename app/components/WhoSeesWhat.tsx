// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// R51: who can see what in a camp, in plain words. Issue #93: the lists of who sees private
// details and dues come from the camp's own roles (camp-roles.server.ts `whoSees`).
import { useCamp } from "~/lib/camp";

function list(items: string[]) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export function WhoSeesWhat({
  campName,
  seesPrivate,
  seesDues,
}: {
  campName: string;
  seesPrivate: string[];
  seesDues: string[] | null;
}) {
  const { productName } = useCamp();
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm">
      <li>
        {`Other members of ${campName} see your Yearbook name and photo, and your contact details only if you choose to share them.`}
      </li>
      <li>
        {`${list(seesPrivate)} can see your contact details even if you don't share them, your mailing address, and the notes organizers keep.`}
      </li>
      {seesDues && <li>{`${list(seesDues)} can see whether you've paid dues.`}</li>}
      <li>
        People your camp gives a role see what that role needs to do its job, like your RSVP, ticket
        request and camp history. Admins manage the camp's settings.
      </li>
      <li>
        {`${productName} hosts the site. It sees ${campName}'s data only when one of the camp's Admins grants it support access, and every page it opens is listed in the camp's Activity for Admins to see.`}
      </li>
    </ul>
  );
}
