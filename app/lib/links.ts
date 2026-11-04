// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Text a camp typed that ends up in email (edited wording, the camp's name) must not carry
// links: the only link in an email is the system's own (R35). Mail apps turn anything that
// looks like an address into a link, so this refuses schemes, "www." and domain-like words
// ("camp.app", "x@y.org"), while allowing ordinary abbreviations ("e.g.", "St. Elmo", "5.30").
const LINK_LIKE = /[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\b[a-z0-9-]+\.[a-z]{2,}\b|@[a-z0-9-]+\./i;

export const looksLikeLink = (text: string) => LINK_LIKE.test(text);
