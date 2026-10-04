import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAvailability, formatAvailability, isWithin, mergeSlots } from "../src/domain/availability.js";
import { localParts, startOfLocalDay, isValidTimeZone, parseLocalDateTime } from "../src/domain/time.js";
import { parseDurationText, formatVnd } from "../src/domain/pricing.js";
import { vn } from "./helpers.js";

const VN = "Asia/Ho_Chi_Minh";

test("the example from the brief parses into three slots", () => {
  const r = parseAvailability("T2 19:00-23:00; T7 14:00-22:00; CN 09:00-12:00");
  assert.equal(r.ok, true);
  assert.deepEqual(r.slots, [
    { weekday: 0, startMin: 540, endMin: 720 },
    { weekday: 1, startMin: 1140, endMin: 1380 },
    { weekday: 6, startMin: 840, endMin: 1320 },
  ]);
});

test("T2 is Monday and T7 is Saturday, CN is Sunday", () => {
  const days = (text) => parseAvailability(text).slots.map((s) => s.weekday);
  assert.deepEqual(days("T2 08:00-09:00"), [1]);
  assert.deepEqual(days("T3 08:00-09:00"), [2]);
  assert.deepEqual(days("T6 08:00-09:00"), [5]);
  assert.deepEqual(days("T7 08:00-09:00"), [6]);
  assert.deepEqual(days("CN 08:00-09:00"), [0]);
});

test("spelled-out days, accents, case and spacing are accepted", () => {
  for (const text of ["thu 2 19:00-23:00", "Thứ 2 19:00-23:00", "THU2 19:00-23:00", "t 2 19h-23h", "Th2 19:00 - 23:00", "t2 19:00–23:00"]) {
    const r = parseAvailability(text);
    assert.equal(r.ok, true, text);
    assert.deepEqual(r.slots, [{ weekday: 1, startMin: 1140, endMin: 1380 }], text);
  }
  assert.deepEqual(parseAvailability("Chủ nhật 09:00-12:00").slots[0].weekday, 0);
  assert.deepEqual(parseAvailability("chu nhat 09:00-12:00").slots[0].weekday, 0);
  assert.deepEqual(parseAvailability("cn 9h30-12h").slots, [{ weekday: 0, startMin: 570, endMin: 720 }]);
});

test("new lines work as separators and several ranges can share a day", () => {
  const r = parseAvailability("T2 09:00-12:00, 14:00-18:00\nT3 20:00-22:00");
  assert.equal(r.ok, true);
  assert.equal(r.slots.length, 3);
  assert.equal(formatAvailability(r.slots), "T2 09:00-12:00, 14:00-18:00; T3 20:00-22:00");
});

test("24:00 is allowed as an end and means midnight", () => {
  const r = parseAvailability("T2 20:00-24:00");
  assert.equal(r.ok, true);
  assert.equal(r.slots[0].endMin, 1440);
  assert.equal(parseAvailability("T2 24:00-24:30").ok, false);
  assert.equal(parseAvailability("T2 20:00-24:30").ok, false);
});

test("overlapping and touching ranges are merged", () => {
  assert.deepEqual(parseAvailability("T2 09:00-12:00; T2 12:00-15:00").slots, [{ weekday: 1, startMin: 540, endMin: 900 }]);
  assert.deepEqual(parseAvailability("T2 09:00-13:00; T2 12:00-15:00").slots, [{ weekday: 1, startMin: 540, endMin: 900 }]);
  assert.equal(mergeSlots([]).length, 0);
});

test("every kind of mistake is reported, in Vietnamese, without stopping at the first", () => {
  const r = parseAvailability("T9 19:00-23:00; T2 25:00-26:00; T3 23:00-19:00; T4 19:10-20:00; T5; xyz");
  assert.equal(r.ok, false);
  assert.deepEqual(r.slots, []);
  assert.equal(r.errors.length, 6);
  assert.match(r.errors[0], /T9/);
  assert.match(r.errors[2], /sau giờ bắt đầu/);
  assert.match(r.errors[3], /30 phút/);
  assert.match(r.errors[4], /Thiếu giờ/);
});

test("empty, non-string and oversized input fail cleanly", () => {
  for (const bad of ["", "   ", null, undefined, 42, ";;;"]) assert.equal(parseAvailability(bad).ok, false);
  assert.equal(parseAvailability("T2 09:00-10:00; ".repeat(40)).ok, false);
});

test("a range that crosses midnight inside one slot is refused with advice to split it", () => {
  const r = parseAvailability("T2 22:00-02:00");
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /tách thành hai ngày/);
  assert.equal(parseAvailability("T2 10:00-10:00").ok, false);
});

test("formatAvailability lists Monday first, Sunday last, and round-trips through parse", () => {
  const text = "CN 09:00-12:00; T7 14:00-22:00; T2 19:00-23:00";
  const slots = parseAvailability(text).slots;
  const out = formatAvailability(slots);
  assert.equal(out, "T2 19:00-23:00; T7 14:00-22:00; CN 09:00-12:00");
  assert.deepEqual(parseAvailability(out).slots, slots);
  assert.equal(formatAvailability([]), "");
});

test("too many ranges in one day are refused", () => {
  const r = parseAvailability("T2 00:00-01:00, 02:00-03:00, 04:00-05:00, 06:00-07:00, 08:00-09:00");
  assert.equal(r.ok, false);
});

const slots = parseAvailability("T2 19:00-23:00; T3 00:00-02:00; T7 14:00-22:00; CN 09:00-12:00").slots;

test("isWithin accepts a booking inside a slot", () => {
  // Monday 5 October 2026
  assert.equal(isWithin(slots, vn(2026, 10, 5, 20, 0), 60, VN), true);
});

test("a slot that ends exactly when the booking ends is enough, and so is one that starts exactly when it starts", () => {
  assert.equal(isWithin(slots, vn(2026, 10, 5, 22, 0), 60, VN), true);
  assert.equal(isWithin(slots, vn(2026, 10, 5, 19, 0), 60, VN), true);
  assert.equal(isWithin(slots, vn(2026, 10, 5, 22, 30), 60, VN), false, "ends 30 minutes after the slot");
  assert.equal(isWithin(slots, vn(2026, 10, 5, 18, 30), 60, VN), false, "starts 30 minutes before the slot");
});

test("the weekday is read in the booking's time zone, not UTC", () => {
  // Monday 19:00 in Vietnam is Monday 12:00 UTC; Sunday 09:00 in Vietnam is Sunday 02:00 UTC
  assert.equal(isWithin(slots, vn(2026, 10, 4, 9, 0), 120, VN), true);
  // Monday 01:00 in Vietnam is still Sunday 18:00 UTC
  const mondayEarly = vn(2026, 10, 5, 1, 0);
  assert.equal(new Date(mondayEarly).getUTCDay(), 0);
  assert.equal(isWithin(slots, mondayEarly, 60, VN), false, "Monday 01:00 is not free");
  assert.equal(isWithin(parseAvailability("T2 00:00-02:00").slots, mondayEarly, 60, VN), true);
});

test("the same instant is a different weekday in a different zone", () => {
  const instant = Date.UTC(2026, 9, 5, 12, 0); // Monday 19:00 Vietnam
  const mondayEvening = parseAvailability("T2 19:00-23:00").slots;
  assert.equal(isWithin(mondayEvening, instant, 60, "Asia/Ho_Chi_Minh"), true);
  assert.equal(isWithin(mondayEvening, instant, 60, "UTC"), false);
  assert.equal(isWithin(mondayEvening, instant, 60, "America/New_York"), false);
  // 12:00 UTC is 08:00 in New York (UTC-4 in October)
  assert.equal(localParts(instant, "America/New_York").hour, 8);
  assert.equal(isWithin(parseAvailability("T2 08:00-10:00").slots, instant, 60, "America/New_York"), true);
});

test("a booking that crosses midnight is accepted only when both days cover their part", () => {
  // Monday 22:00 to Tuesday 01:00, slots T2 19:00-23:00 and T3 00:00-02:00 do not cover 23:00-24:00
  assert.equal(isWithin(slots, vn(2026, 10, 5, 22, 0), 180, VN), false);
  const both = parseAvailability("T2 19:00-24:00; T3 00:00-02:00").slots;
  assert.equal(isWithin(both, vn(2026, 10, 5, 22, 0), 180, VN), true);
  assert.equal(isWithin(both, vn(2026, 10, 5, 23, 0), 180, VN), true, "ends exactly at the end of the next slot");
  assert.equal(isWithin(both, vn(2026, 10, 5, 23, 30), 180, VN), false);
  // Sunday into Monday wraps the week
  const wrap = parseAvailability("CN 22:00-24:00; T2 00:00-01:00").slots;
  assert.equal(isWithin(wrap, vn(2026, 10, 4, 23, 0), 120, VN), true);
});

test("a booking can span two touching slots of the same day", () => {
  const two = [{ weekday: 1, startMin: 540, endMin: 720 }, { weekday: 1, startMin: 720, endMin: 900 }];
  assert.equal(isWithin(two, vn(2026, 10, 5, 11, 0), 120, VN), true);
});

test("isWithin refuses nonsense input", () => {
  assert.equal(isWithin(slots, vn(2026, 10, 5, 20, 0), 0, VN), false);
  assert.equal(isWithin(slots, vn(2026, 10, 5, 20, 0), -30, VN), false);
  assert.equal(isWithin(slots, vn(2026, 10, 5, 20, 0), 30.5, VN), false);
  assert.equal(isWithin(slots, NaN, 30, VN), false);
  assert.equal(isWithin([], vn(2026, 10, 5, 20, 0), 30, VN), false);
});

test("local time helpers", () => {
  const p = localParts(vn(2026, 10, 5, 0, 0), VN);
  assert.deepEqual([p.year, p.month, p.day, p.hour, p.minute, p.weekday], [2026, 10, 5, 0, 0, 1]);
  assert.equal(startOfLocalDay(vn(2026, 10, 5, 17, 45), VN), vn(2026, 10, 5, 0, 0));
  assert.equal(startOfLocalDay(vn(2026, 10, 5, 23, 59), VN), vn(2026, 10, 5, 0, 0));
  assert.equal(isValidTimeZone("Asia/Ho_Chi_Minh"), true);
  assert.equal(isValidTimeZone("Mars/Base"), false);
  assert.equal(isValidTimeZone(""), false);
});

const NOW_LOCAL = vn(2026, 10, 5, 10, 0);

test("parseLocalDateTime reads the booking modal's date and time in the server's zone", () => {
  const want = vn(2026, 10, 12, 19, 30);
  for (const text of ["12/10 19:30", "12/10/2026 19:30", "19:30 12/10", "12-10 19h30", "12.10 19:30", " 12/10   19:30 ", "12/10 19h30"]) {
    assert.equal(parseLocalDateTime(text, VN, NOW_LOCAL), want, text);
  }
  assert.equal(parseLocalDateTime("12/10 19h", VN, NOW_LOCAL), vn(2026, 10, 12, 19, 0));
  assert.equal(parseLocalDateTime("5/10 07:00", VN, NOW_LOCAL), vn(2026, 10, 5, 7, 0), "today is still this year");
});

test("a date that has already passed this year means next year when no year is given", () => {
  assert.equal(parseLocalDateTime("01/10 20:00", VN, NOW_LOCAL), vn(2027, 10, 1, 20, 0));
  assert.equal(parseLocalDateTime("01/10/2026 20:00", VN, NOW_LOCAL), vn(2026, 10, 1, 20, 0), "an explicit year is respected");
});

test("parseLocalDateTime rejects things that are not real moments", () => {
  for (const bad of ["", null, "xin chào", "31/02 19:00", "32/10 19:00", "12/13 19:00", "12/10 24:00", "12/10 19:60", "12/10", "19:30", "12/10 19:30 thêm", "0/10 19:00"]) {
    assert.equal(parseLocalDateTime(bad, VN, NOW_LOCAL), null, String(bad));
  }
});

test("parseLocalDateTime uses the given zone, and refuses wall times that do not exist in it", () => {
  assert.equal(parseLocalDateTime("12/10 19:30", "UTC", NOW_LOCAL), Date.UTC(2026, 9, 12, 19, 30));
  assert.equal(parseLocalDateTime("12/10 08:00", "America/New_York", NOW_LOCAL), Date.UTC(2026, 9, 12, 12, 0));
  assert.equal(parseLocalDateTime("08/03/2026 02:30", "America/New_York", Date.UTC(2026, 0, 1)), null, "clocks skip 02:00-03:00 that night");
  assert.ok(parseLocalDateTime("08/03/2026 03:30", "America/New_York", Date.UTC(2026, 0, 1)) > 0);
});

test("parseDurationText understands hours, minutes and mixes", () => {
  const cases = { "1": 60, "2": 120, "1.5": 90, "1,5": 90, "0.5": 30, "90": 90, "30": 30, "45": 45, "2h": 120, "1h30": 90, "1h 30": 90, "90p": 90, "90 phút": 90, "90 phut": 90, "90 min": 90, "1.5 giờ": 90, "2 gio": 120, "12": 720, "13": 13 };
  for (const [text, minutes] of Object.entries(cases)) assert.equal(parseDurationText(text), minutes, text);
  for (const bad of ["", null, "abc", "-1", "1h99h", "một giờ"]) assert.equal(parseDurationText(bad), null, String(bad));
});

test("formatVnd groups thousands the Vietnamese way", () => {
  assert.equal(formatVnd(100000), "100.000 đ");
  assert.equal(formatVnd(0), "0 đ");
  assert.equal(formatVnd(1500000), "1.500.000 đ");
});
