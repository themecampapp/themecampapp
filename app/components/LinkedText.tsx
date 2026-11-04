// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Plain text a Lead typed (an announcement), with https addresses shown as links. Each link
// shows its full address, so nobody is misled about where it goes (R62), and only https
// addresses become links. React escapes everything else.
const URL_RE = /https:\/\/[^\s<>"]+/g;

export function LinkedText({ text }: { text: string }) {
  const parts: Array<string | { href: string }> = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    // Trailing punctuation belongs to the sentence, not the address.
    const href = m[0].replace(/[.,;:!?)\]'’]+$/, "");
    const start = m.index ?? 0;
    parts.push(text.slice(last, start), { href });
    last = start + href.length;
  }
  parts.push(text.slice(last));
  return (
    <span className="whitespace-pre-line">
      {parts.map((p, i) =>
        typeof p === "string" ? (
          p
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: static text, never reordered
          <a key={i} href={p.href} rel="nofollow noopener ugc" className="break-all underline">
            {p.href}
          </a>
        ),
      )}
    </span>
  );
}
