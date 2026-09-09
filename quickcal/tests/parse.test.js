// Run: node tests/parse.test.js   (needs node 18+, no npm install)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

// Load the vendored browser bundle into this process, then the app.
(0, eval)(fs.readFileSync(path.join(__dirname, "..", "vendor", "chrono-en.min.js"), "utf8"));
const QC = require("../app.js");

const REF = new Date(2026, 8, 9, 12, 0, 0); // Wed 9 Sep 2026, noon, local time
const TZ = "America/Los_Angeles";
const parse = (text, ref) => QC.parseMessage(text, ref || REF, { tz: TZ });

const EXAMPLE = "$TPAK LA Meetup… Wed Sep 16th. Drinks @ 3pm, dinner @ 6pm. Drinks at Casa Del Mar… dinner at Shutters on the Beach… Drinks window is 3 to 6… See you all in 2wks! Damian";

test("example message: two cards on Wed 16 Sep 2026", () => {
  const r = parse(EXAMPLE);
  assert.equal(r.events.length, 2, JSON.stringify(r.events.map(e => [e.date, e.start, e.end])));
  const [a, b] = r.events;
  assert.equal(a.date, "2026-09-16"); assert.equal(a.start, "15:00"); assert.equal(a.end, "18:00");
  assert.equal(b.date, "2026-09-16"); assert.equal(b.start, "18:00"); assert.equal(b.end, "19:00");
  assert.equal(a.location, "Casa Del Mar");
  assert.equal(b.location, "Shutters on the Beach");
  assert.equal(a.title, "Drinks \u00b7 LA Meetup"); // "$TPAK" tag is stripped on purpose
  assert.match(b.title, /^Dinner/);
  assert.equal(a.notes, EXAMPLE);
  assert.equal(a.allDay, false);
});

test("title strips $tags and emoji, cuts at sentence end", () => {
  assert.equal(QC.guessTitle("$TPAK LA Meetup… Wed Sep 16th."), "LA Meetup");
  assert.equal(QC.guessTitle("🎉 Birthday dinner!! Sat 8pm at Nobu"), "Birthday dinner");
  assert.equal(QC.guessTitle("\n\n  Team offsite - details below\nMonday"), "Team offsite");
});

test("no year -> nearest future date (next year when already passed)", () => {
  const r = parse("Reunion on Sep 1st at 7pm");
  assert.equal(r.events[0].date, "2027-09-01");
  assert.ok(r.events[0].flags.some(f => /No year/.test(f)));
});

test("bare time with no date -> assumed date, flagged", () => {
  const r = parse("call me at 4pm");
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].start, "16:00");
  assert.ok(r.events[0].flags.some(f => /No date/.test(f)));
});

test("date with no time -> all-day", () => {
  const r = parse("Dentist appointment October 3");
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].allDay, true);
  assert.equal(r.events[0].date, "2026-10-03");
});

test("range in one phrase and next-day wrap", () => {
  let r = parse("Party Friday 9pm-1am at The Standard");
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].start, "21:00"); assert.equal(r.events[0].end, "01:00");
  assert.equal(r.events[0].endDate, "2026-09-12"); // Fri 11 Sep -> ends Sat
  assert.equal(r.events[0].location, "The Standard");
  r = parse("Sale runs 11 to 2 on Saturday");
  assert.equal(r.events[0].start, "11:00"); assert.equal(r.events[0].end, "14:00");
});

test("two dates, times attach to the nearest preceding date", () => {
  const r = parse("Workshop:\nTue Sep 22 — 10am session, 2pm session\nWed Sep 23 — 9am wrap-up");
  assert.deepEqual(r.events.map(e => e.date + " " + e.start), ["2026-09-22 10:00", "2026-09-22 14:00", "2026-09-23 09:00"]);
});

test("nothing parseable -> zero events", () => {
  assert.equal(parse("Hey, are we still on? Let me know").events.length, 0);
});

test("weekday mismatch is flagged, not silently fixed", () => {
  const r = parse("Meeting Tue Sep 16 at 10am");
  assert.equal(r.events[0].date, "2026-09-16");
  assert.ok(r.events[0].flags.some(f => /Message says Tuesday/.test(f)), r.events[0].flags.join("|"));
});

test("ics: timed event uses TZID and CRLF, all-day uses VALUE=DATE with exclusive end", () => {
  const r = parse(EXAMPLE);
  const ics = QC.buildIcs(r.events, { now: new Date(Date.UTC(2026, 8, 9, 12, 0, 0)) });
  assert.ok(ics.split("\r\n").length > 10);
  assert.ok(!/[^\r]\n/.test(ics), "all line breaks must be CRLF");
  assert.match(ics, /DTSTART;TZID=America\/Los_Angeles:20260916T150000/);
  assert.match(ics, /DTEND;TZID=America\/Los_Angeles:20260916T180000/);
  assert.match(ics, /DTSTAMP:20260909T120000Z/);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2);
  assert.match(ics, /UID:[0-9a-f-]{36}@quickcal/);
  assert.match(ics, /LOCATION:Casa Del Mar/);
  for (const line of ics.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75, "line too long: " + line);
  const ad = QC.buildIcs(parse("Dentist appointment October 3").events);
  assert.match(ad, /DTSTART;VALUE=DATE:20261003\r\nDTEND;VALUE=DATE:20261004/);
  const utc = QC.buildIcs(r.events, { timeFormat: "utc" });
  assert.match(utc, /DTSTART:20260916T220000Z/); // 3pm PDT = 22:00 UTC
});

test("ics escapes commas, semicolons and newlines in text fields", () => {
  const ev = { title: "A, B; C", date: "2026-10-03", allDay: true, endDate: "2026-10-03", notes: "line1\nline2", tz: TZ };
  const ics = QC.buildIcs([ev]);
  assert.ok(ics.includes("SUMMARY:A\\, B\\; C"), ics);
  assert.match(ics, /DESCRIPTION:line1\\nline2/);
});

test("google url", () => {
  const r = parse(EXAMPLE);
  const u = QC.googleUrl(r.events[0]);
  assert.ok(u.startsWith("https://calendar.google.com/calendar/render?action=TEMPLATE&text="));
  assert.match(u, /&dates=20260916T150000\/20260916T180000&ctz=America%2FLos_Angeles&location=Casa%20Del%20Mar&details=/);
  const ad = QC.googleUrl(parse("Dentist appointment October 3").events[0]);
  assert.match(ad, /&dates=20261003\/20261004(&|$)/);
  assert.ok(!/ctz/.test(ad));
});

test("zonedToUtc handles DST", () => {
  assert.equal(QC.zonedToUtc("2026-07-01", "12:00", "Europe/London").toISOString(), "2026-07-01T11:00:00.000Z");
  assert.equal(QC.zonedToUtc("2026-01-01", "12:00", "Europe/London").toISOString(), "2026-01-01T12:00:00.000Z");
  assert.equal(QC.zonedToUtc("2026-01-01", "12:00", "Asia/Kuwait").toISOString(), "2026-01-01T09:00:00.000Z");
});
