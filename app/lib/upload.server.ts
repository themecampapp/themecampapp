// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { data } from "react-router";

// An uploaded file's bytes, refused before it's read into memory if it's over `max` (the
// Worker has already refused a request body over its overall limit: workers/app.ts).
export async function readUpload(file: File, max: number, tooLarge: string) {
  if (file.size > max) throw data({ reason: tooLarge }, { status: 413 });
  return new Uint8Array(await file.arrayBuffer());
}
