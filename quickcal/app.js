/* QuickCal — parsing rules and UI. Plain JS, no framework, no network.
   Rules, not AI: chrono-node finds date/time phrases, everything else is
   simple heuristics that are labelled "guessed" in the UI.
   The parsing half also runs under node for tests (see tests/parse.test.js). */
(function (global) {
  "use strict";

  var APP_VERSION = "0.1.0";
  var DEFAULT_DURATION_MIN = 60;

  // ---------------------------------------------------------------- helpers
  function pad2(n) { return String(n).padStart(2, "0"); }
  function dateKey(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
  function timeKey(d) { return pad2(d.getHours()) + ":" + pad2(d.getMinutes()); }
  function splitDate(key) { var p = key.split("-").map(Number); return { y: p[0], m: p[1], d: p[2] }; }
  function splitTime(key) { var p = key.split(":").map(Number); return { h: p[0], mi: p[1] || 0 }; }
  function toLocalDate(dateK, timeK) {
    var a = splitDate(dateK), b = splitTime(timeK || "00:00");
    return new Date(a.y, a.m - 1, a.d, b.h, b.mi);
  }
  function addDays(dateK, n) {
    var a = splitDate(dateK);
    return dateKey(new Date(a.y, a.m - 1, a.d + n));
  }
  function addMinutes(dateK, timeK, mins) {
    var a = splitDate(dateK), b = splitTime(timeK);
    var dt = new Date(a.y, a.m - 1, a.d, b.h, b.mi + mins);
    return { date: dateKey(dt), time: timeKey(dt) };
  }
  function minutesOf(timeK) { var t = splitTime(timeK); return t.h * 60 + t.mi; }
  function compactDate(dateK) { return dateK.replace(/-/g, ""); }
  function compactTime(timeK) { return timeK.replace(":", "") + "00"; }

  var DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  function longDate(dateK) {
    var d = toLocalDate(dateK);
    return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  }
  function shortDate(dateK) {
    var d = toLocalDate(dateK);
    return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  }
  function time12(timeK) {
    var t = splitTime(timeK);
    var h = t.h % 12; if (h === 0) h = 12;
    return h + ":" + pad2(t.mi) + (t.h < 12 ? " am" : " pm");
  }

  function deviceTimeZone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch (e) { return "UTC"; }
  }

  // Convert a wall-clock time in an IANA zone to a real instant, using only Intl.
  function tzOffsetMinutes(utcMs, tz) {
    var dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    });
    var parts = {};
    dtf.formatToParts(new Date(utcMs)).forEach(function (p) { parts[p.type] = p.value; });
    var asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, (+parts.hour) % 24, +parts.minute, +parts.second);
    return (asUtc - utcMs) / 60000;
  }
  function zonedToUtc(dateK, timeK, tz) {
    var a = splitDate(dateK), b = splitTime(timeK);
    var guess = Date.UTC(a.y, a.m - 1, a.d, b.h, b.mi);
    var off1 = tzOffsetMinutes(guess, tz);
    var utc = guess - off1 * 60000;
    var off2 = tzOffsetMinutes(utc, tz);
    if (off2 !== off1) utc = guess - off2 * 60000;
    return new Date(utc);
  }
  function utcStamp(d) {
    return d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()) + "T" +
      pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds()) + "Z";
  }

  function uuid() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    var s = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx";
    return s.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0, v = c === "x" ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  // ----------------------------------------------------------- title guess
  var EMOJI_RE;
  try {
    EMOJI_RE = new RegExp("[\\p{Extended_Pictographic}\\u{FE0F}\\u{200D}\\u{20E3}]", "gu");
  } catch (e) {
    EMOJI_RE = /[\uD83C-\uDBFF][\uDC00-\uDFFF]|[\u2600-\u27BF]|\uFE0F|\u200D/g;
  }

  // Title = first non-empty line, minus emoji and $TAGS, cut at the first sentence end.
  function guessTitle(text) {
    var firstLine = "";
    var lines = String(text || "").split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var candidate = lines[i].replace(/\$[A-Za-z0-9_]+/g, "").replace(EMOJI_RE, "").trim();
      if (candidate.length) { firstLine = candidate; break; }
    }
    var t = firstLine.replace(/[#*_~`>|]+/g, " ");
    var m = t.match(/^(.*?)(?:[.!?…]|\s[-–—]\s|:\s)/);
    if (m && m[1].trim().length >= 3) t = m[1];
    t = t.replace(/\s+/g, " ").trim().replace(/[\s,;:\-–—]+$/, "");
    if (t.length > 60) t = t.slice(0, 57).trim() + "…";
    return t || "Event";
  }

  // --------------------------------------------------------- activity label
  // "Drinks @ 3pm" -> "Drinks". Looks at the few words right before a time phrase.
  var TAIL_STOP = ["is", "are", "at", "from", "on", "the", "a", "an", "and", "starts", "start", "begins",
    "begin", "starting", "around", "about", "by", "until", "till", "to", "for", "of", "in", "window",
    "time", "times", "be", "will", "we", "i", "you", "it", "its", "it's", "this", "that", "there", "here",
    "us", "all", "see", "with", "do", "or", "then", "later", "after", "before", "&", "-", "–", "—", "@",
    "sharp", "ish", "approx", "roughly", "meet", "meeting", "please", "pls", "everyone", "everybody"];
  var LEAD_STOP = ["then", "and", "&", "also", "followed", "by", "with", "the", "a", "an", "our", "my",
    "your", "for", "to", "so", "but", "or", "afterwards", "after", "before", "next", "-", "–", "—"];

  function guessLabel(text, index, minIndex) {
    var from = Math.max(minIndex || 0, index - 45);
    var win = text.slice(from, index);
    var pieces = win.split(/[\n.!?…;,()\[\]"]|\s[-–—]\s/);
    win = pieces[pieces.length - 1];
    win = win.replace(/[@:\-–—]+\s*$/, " ").trim();
    var words = win.split(/\s+/).filter(Boolean);
    var clean = function (w) { return w.toLowerCase().replace(/[^a-z'&\-–—@]/g, ""); };
    while (words.length && TAIL_STOP.indexOf(clean(words[words.length - 1])) !== -1) words.pop();
    while (words.length && LEAD_STOP.indexOf(clean(words[0])) !== -1) words.shift();
    words = words.slice(-3);
    var label = words.join(" ").replace(/^[^A-Za-z]+/, "").replace(/[^A-Za-z)]+$/, "");
    if (!label || label.length < 3 || label.length > 30) return "";
    if (/\d/.test(label)) return "";
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  // --------------------------------------------------------- location guess
  // "at Casa Del Mar", "@ Shutters on the Beach": a capitalised name after at/@.
  var CAP = "[A-Z][A-Za-z0-9'’.&-]*";
  var CONN = "(?:on|the|of|de|del|la|le|du|des|da|di|and|&|by|in)";
  var LOC_RE = new RegExp("(?:\\bat|@)\\s+((?:the\\s+)?" + CAP + "(?:\\s+(?:" + CAP + "|" + CONN + "\\b))*)", "g");
  var TRAILING_CONN_RE = new RegExp("\\s+" + CONN + "$", "i");

  function findLocations(text, ranges) {
    var out = [];
    var m;
    LOC_RE.lastIndex = 0;
    while ((m = LOC_RE.exec(text)) !== null) {
      var name = m[1];
      var nameStart = m.index + m[0].length - name.length;
      // strip dangling connectors: "Casa Del Mar and" -> "Casa Del Mar"
      var prev;
      do { prev = name; name = name.replace(TRAILING_CONN_RE, ""); } while (name !== prev);
      name = name.replace(/[.,;:]+$/, "");
      if (!name || !/[A-Za-z]{2,}/.test(name)) continue;
      // skip if it overlaps a date/time phrase ("at Noon", "at Sep 16")
      var overlaps = (ranges || []).some(function (r) {
        return nameStart < r.end && (nameStart + name.length) > r.start;
      });
      if (overlaps) continue;
      var before = text.slice(Math.max(0, m.index - 40), m.index);
      var seg = before.split(/[\n.!?…;,]/).pop().trim();
      var words = seg.split(/\s+/).filter(Boolean);
      out.push({ name: name, index: m.index, prev: words.length ? words[words.length - 1].replace(/[^A-Za-z'’]/g, "") : "" });
    }
    return out;
  }

  function normWord(w) { return String(w || "").toLowerCase().replace(/s$/, ""); }

  function assignLocations(events, locs) {
    var used = [];
    events.forEach(function (ev) {
      if (!ev.label) return;
      var first = normWord(ev.label.split(" ")[0]);
      for (var i = 0; i < locs.length; i++) {
        var l = locs[i];
        if (l.prev && normWord(l.prev) === first && used.indexOf(l) === -1) {
          ev.location = l.name; ev.locationGuessed = true;
          ev.locationWhy = "from \u201c" + l.prev + " at " + l.name + "\u201d";
          used.push(l);
          break;
        }
      }
    });
    events.forEach(function (ev) {
      if (ev.location) return;
      var best = null, bestD = Infinity;
      locs.forEach(function (l) {
        if (used.indexOf(l) !== -1 && used.length < locs.length) return;
        var d = Math.abs(l.index - ev.index);
        if (d < bestD) { bestD = d; best = l; }
      });
      if (best && bestD <= 250) {
        ev.location = best.name; ev.locationGuessed = true;
        ev.locationWhy = "nearest \u201cat \u2026\u201d phrase";
        used.push(best);
      }
    });
  }

  // ------------------------------------------------------------ parsing
  function hasDate(r) {
    var s = r.start;
    return s.isCertain("day") || s.isCertain("month") || s.isCertain("weekday") || s.isCertain("year");
  }
  function hasTime(r) { return r.start.isCertain("hour"); }

  // Bare "3" or "3 to 6" with no am/pm: 1–6 are far more often afternoon.
  function fixMeridiem(comp) {
    var h = comp.get("hour"), mi = comp.get("minute") || 0, note = null;
    if (!comp.isCertain("meridiem")) {
      if (h >= 1 && h <= 6) { h += 12; note = "pm-assumed"; }
      else if (h >= 7 && h <= 11) { note = "ampm-unstated"; }
    }
    return { time: pad2(h) + ":" + pad2(mi), note: note, rawHour: comp.get("hour") };
  }

  function buildEvent(text, r, anchor, title) {
    var ev = {
      id: uuid(), title: title, titleGuessed: true, label: "",
      date: "", allDay: false, start: "", end: "", endDate: "",
      location: "", locationGuessed: false, locationWhy: "",
      notes: text, tz: "", index: r.index, sourceText: r.text, flags: [], _endDefaulted: false
    };
    if (anchor) ev.sourceText = anchor.text + " + " + r.text;
    var dateComp = anchor ? anchor.start : r.start;
    var anchored = !!anchor;
    var noDateAtAll = !anchor && !hasDate(r);
    ev.date = dateKey(anchored ? anchor.start.date() : r.start.date());

    ev.allDay = !hasTime(r);
    if (!ev.allDay) {
      var st = fixMeridiem(r.start);
      ev.start = st.time;
      if (st.note === "pm-assumed") ev.flags.push("\u201c" + r.text + "\u201d has no am/pm \u2014 assumed " + time12(st.time));
      if (st.note === "ampm-unstated") ev.flags.push("\u201c" + r.text + "\u201d has no am/pm \u2014 read as " + time12(st.time) + ", check it");

      if (r.end && r.end.isCertain("hour")) {
        var en = fixMeridiem(r.end);
        ev.end = en.time;
        ev.endDate = anchored ? ev.date : dateKey(r.end.date());
        if (minutesOf(ev.end) <= minutesOf(ev.start) && ev.endDate <= ev.date) {
          if (en.note === "pm-assumed") {
            ev.end = pad2(en.rawHour) + ":" + ev.end.slice(3); // e.g. "9pm to 1" -> 01:00 next day
          }
          ev.endDate = addDays(ev.date, 1);
          ev.flags.push("End time is earlier than start \u2014 moved end to the next day");
        }
      } else {
        var e = addMinutes(ev.date, ev.start, DEFAULT_DURATION_MIN);
        ev.end = e.time; ev.endDate = e.date; ev._endDefaulted = true;
        ev.flags.push("No end time given \u2014 set to 1 hour");
      }
    } else {
      ev.endDate = ev.date;
      if (r.end && r.end.isCertain("day")) {
        var ed = dateKey(r.end.date());
        if (ed > ev.date) ev.endDate = ed;
      }
      ev.flags.push("No time found \u2014 made it an all-day event");
    }

    if (noDateAtAll) {
      ev.flags.push("No date in the message \u2014 assumed " + shortDate(ev.date) + ". Change it if wrong");
    } else {
      if (dateComp.isCertain("month") && !dateComp.isCertain("year")) {
        ev.flags.push("No year in the message \u2014 assumed " + splitDate(ev.date).y + " (next time this date comes round)");
      }
      var kw = dateComp.knownValues ? dateComp.knownValues.weekday : undefined;
      if (kw !== undefined && kw !== null && dateComp.isCertain("day")) {
        var actual = toLocalDate(ev.date).getDay();
        if (actual !== kw) {
          ev.flags.push("Message says " + DAY_NAMES[kw] + " but " + shortDate(ev.date) + " is a " + DAY_NAMES[actual] + " \u2014 check the date");
        }
      }
    }
    return ev;
  }

  function parseMessage(text, refDate, options) {
    options = options || {};
    var chrono = options.chrono || global.chrono;
    if (!chrono) throw new Error("chrono-node not loaded");
    var tz = options.tz || deviceTimeZone();
    var ref = refDate || new Date();
    text = String(text || "");
    var results = chrono.casual.parse(text, ref, { forwardDate: true });
    var title = guessTitle(text);

    var dated = [], timesOnly = [];
    results.forEach(function (r) { (hasDate(r) ? dated : timesOnly).push(r); });

    var events = [];
    var anchorsWithTimes = [];
    var prevEnd = 0;

    results.forEach(function (r, i) {
      var start = r.index, end = r.index + r.text.length;
      var minIndex = i > 0 ? results[i - 1].index + results[i - 1].text.length : 0;
      var ev = null;
      if (hasDate(r) && hasTime(r)) {
        ev = buildEvent(text, r, null, title);
        anchorsWithTimes.push(r);
      } else if (!hasDate(r) && hasTime(r)) {
        var anchor = null;
        for (var j = dated.length - 1; j >= 0; j--) { if (dated[j].index < r.index) { anchor = dated[j]; break; } }
        if (!anchor) { for (var k = 0; k < dated.length; k++) { if (dated[k].index > r.index) { anchor = dated[k]; break; } } }
        ev = buildEvent(text, r, anchor, title);
        if (anchor) anchorsWithTimes.push(anchor);
      }
      if (ev) {
        ev.label = guessLabel(text, r.index, minIndex);
        events.push(ev);
      }
      prevEnd = end;
    });

    dated.forEach(function (r) {
      if (hasTime(r)) return;
      if (anchorsWithTimes.indexOf(r) !== -1) return;
      var ev = buildEvent(text, r, null, title);
      var i = results.indexOf(r);
      var minIndex = i > 0 ? results[i - 1].index + results[i - 1].text.length : 0;
      ev.label = guessLabel(text, r.index, minIndex);
      events.push(ev);
    });

    // One card per distinct start time: "3pm" and "3 to 6" on the same day merge.
    var byKey = {}, merged = [];
    events.forEach(function (ev) {
      var key = ev.date + "|" + (ev.allDay ? "allday" : ev.start);
      var prev = byKey[key];
      if (!prev) { byKey[key] = ev; merged.push(ev); return; }
      var keep = prev, drop = ev;
      if (prev._endDefaulted && !ev._endDefaulted) { keep = ev; drop = prev; }
      keep.label = keep.label || drop.label;
      if (drop.label && keep.label && drop.index < keep.index) keep.label = drop.label;
      keep.index = Math.min(keep.index, drop.index);
      keep.sourceText = prev.sourceText + " / " + ev.sourceText;
      keep.flags = keep.flags.filter(function (f) { return f.indexOf("No end time") !== 0 || keep._endDefaulted; });
      drop.flags.forEach(function (f) { if (keep.flags.indexOf(f) === -1 && !(f.indexOf("No end time") === 0)) keep.flags.push(f); });
      if (keep !== prev) { byKey[key] = keep; merged[merged.indexOf(prev)] = keep; }
    });
    events = merged;

    events.sort(function (a, b) {
      var ka = a.date + (a.allDay ? "" : "T" + a.start), kb = b.date + (b.allDay ? "" : "T" + b.start);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });

    var ranges = results.map(function (r) { return { start: r.index, end: r.index + r.text.length }; });
    var locs = findLocations(text, ranges);
    assignLocations(events, locs);

    events.forEach(function (ev) {
      ev.tz = tz;
      if (ev.label && ev.label.toLowerCase() !== title.toLowerCase()) ev.title = ev.label + " \u00b7 " + title;
      ev.titleGuessed = true;
      delete ev._endDefaulted;
    });

    return {
      events: events,
      title: title,
      phrases: results.map(function (r) { return r.text; }),
      locations: locs.map(function (l) { return l.name; })
    };
  }

  // -------------------------------------------------------------- ICS
  function icsEscape(s) {
    return String(s || "").replace(/\\/g, "\\\\").replace(/\r\n|\r|\n/g, "\\n").replace(/;/g, "\\;").replace(/,/g, "\\,");
  }
  var encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
  function byteLen(ch) { return encoder ? encoder.encode(ch).length : ch.length; }
  // RFC 5545: lines no longer than 75 octets, continuation lines start with a space.
  function foldLine(line) {
    var out = [], cur = "", bytes = 0;
    var chars = Array.from(line);
    for (var i = 0; i < chars.length; i++) {
      var b = byteLen(chars[i]);
      if (bytes + b > 75) { out.push(cur); cur = " " + chars[i]; bytes = 1 + b; }
      else { cur += chars[i]; bytes += b; }
    }
    out.push(cur);
    return out.join("\r\n");
  }

  function buildIcs(events, opts) {
    opts = opts || {};
    var now = opts.now || new Date();
    var lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//QuickCal//QuickCal " + APP_VERSION + "//EN",
      "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
    events.forEach(function (ev) {
      lines.push("BEGIN:VEVENT");
      lines.push("UID:" + (ev.uid || uuid()) + "@quickcal");
      lines.push("DTSTAMP:" + utcStamp(now));
      if (ev.allDay) {
        lines.push("DTSTART;VALUE=DATE:" + compactDate(ev.date));
        lines.push("DTEND;VALUE=DATE:" + compactDate(addDays(ev.endDate || ev.date, 1)));
      } else if (opts.timeFormat === "utc" || ev.tz === "UTC" || ev.tz === "Etc/UTC") {
        lines.push("DTSTART:" + utcStamp(zonedToUtc(ev.date, ev.start, ev.tz)));
        lines.push("DTEND:" + utcStamp(zonedToUtc(ev.endDate || ev.date, ev.end, ev.tz)));
      } else {
        lines.push("DTSTART;TZID=" + ev.tz + ":" + compactDate(ev.date) + "T" + compactTime(ev.start));
        lines.push("DTEND;TZID=" + ev.tz + ":" + compactDate(ev.endDate || ev.date) + "T" + compactTime(ev.end));
      }
      lines.push("SUMMARY:" + icsEscape(ev.title || "Event"));
      if (ev.location) lines.push("LOCATION:" + icsEscape(ev.location));
      if (ev.notes) lines.push("DESCRIPTION:" + icsEscape(ev.notes));
      lines.push("END:VEVENT");
    });
    lines.push("END:VCALENDAR");
    return lines.map(foldLine).join("\r\n") + "\r\n";
  }

  // ------------------------------------------------------------ Google
  function googleUrl(ev) {
    var dates = ev.allDay
      ? compactDate(ev.date) + "/" + compactDate(addDays(ev.endDate || ev.date, 1))
      : compactDate(ev.date) + "T" + compactTime(ev.start) + "/" + compactDate(ev.endDate || ev.date) + "T" + compactTime(ev.end);
    var q = "action=TEMPLATE&text=" + encodeURIComponent(ev.title || "Event") + "&dates=" + dates;
    if (!ev.allDay && ev.tz) q += "&ctz=" + encodeURIComponent(ev.tz);
    if (ev.location) q += "&location=" + encodeURIComponent(ev.location);
    if (ev.notes) q += "&details=" + encodeURIComponent(ev.notes);
    return "https://calendar.google.com/calendar/render?" + q;
  }

  function describe(ev) {
    var s = shortDate(ev.date);
    if (ev.allDay) {
      s += ev.endDate && ev.endDate !== ev.date ? " to " + shortDate(ev.endDate) + ", all day" : ", all day";
    } else {
      s += ", " + time12(ev.start) + " to " + (ev.endDate && ev.endDate !== ev.date ? shortDate(ev.endDate) + " " : "") + time12(ev.end);
    }
    return s;
  }

  var api = {
    version: APP_VERSION, parseMessage: parseMessage, buildIcs: buildIcs, googleUrl: googleUrl,
    guessTitle: guessTitle, guessLabel: guessLabel, findLocations: findLocations, zonedToUtc: zonedToUtc,
    describe: describe, deviceTimeZone: deviceTimeZone, longDate: longDate, shortDate: shortDate, time12: time12
  };
  global.QuickCal = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;

  // =================================================================== UI
  if (typeof document === "undefined") return;

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var state = { events: [], text: "", title: "" };
  var settings = { iosMethod: "blob", icsTime: "tzid" };
  try {
    var saved = JSON.parse(localStorage.getItem("quickcal.settings") || "{}");
    if (saved.iosMethod) settings.iosMethod = saved.iosMethod;
    if (saved.icsTime) settings.icsTime = saved.icsTime;
  } catch (e) { /* storage unavailable, keep defaults */ }
  function saveSettings() { try { localStorage.setItem("quickcal.settings", JSON.stringify(settings)); } catch (e) { /* ignore */ } }

  var canShareFiles = false;
  try {
    if (navigator.canShare && typeof File === "function") {
      canShareFiles = navigator.canShare({ files: [new File(["x"], "test.ics", { type: "text/calendar" })] });
    }
  } catch (e) { canShareFiles = false; }

  var TZ_LIST = [];
  try { TZ_LIST = Intl.supportedValuesOf("timeZone"); } catch (e) {
    TZ_LIST = ["UTC", "America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York",
      "America/Toronto", "America/Mexico_City", "America/Sao_Paulo", "Europe/London", "Europe/Paris",
      "Europe/Berlin", "Europe/Madrid", "Europe/Rome", "Europe/Istanbul", "Asia/Dubai", "Asia/Kuwait",
      "Asia/Riyadh", "Asia/Kolkata", "Asia/Singapore", "Asia/Hong_Kong", "Asia/Tokyo", "Australia/Sydney"];
  }
  var DEVICE_TZ = deviceTimeZone();
  if (TZ_LIST.indexOf(DEVICE_TZ) === -1) TZ_LIST.unshift(DEVICE_TZ);

  function toast(msg) {
    var t = $("#toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.hidden = true; }, 3500);
  }

  function fileName(events) {
    var base = events.length === 1 ? (events[0].title || "event") : "quickcal-" + events.length + "-events";
    return base.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "event";
  }

  function icsHref(events) {
    var ics = buildIcs(events, { timeFormat: settings.icsTime });
    if (settings.iosMethod === "data") return "data:text/calendar;charset=utf-8," + encodeURIComponent(ics);
    var blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    return URL.createObjectURL(blob);
  }

  function shareIcs(events) {
    var ics = buildIcs(events, { timeFormat: settings.icsTime });
    var file;
    try { file = new File([ics], fileName(events) + ".ics", { type: "text/calendar" }); } catch (e) { toast("This browser cannot share files."); return; }
    if (!(navigator.canShare && navigator.canShare({ files: [file] }))) { toast("Sharing .ics files is not supported here."); return; }
    navigator.share({ files: [file], title: fileName(events) }).catch(function (err) {
      if (err && err.name !== "AbortError") toast("Share failed: " + err.message);
    });
  }

  function fillTzSelect(sel, value) {
    sel.textContent = "";
    TZ_LIST.forEach(function (tz) {
      var o = document.createElement("option");
      o.value = tz; o.textContent = tz === DEVICE_TZ ? tz + " (this device)" : tz;
      sel.appendChild(o);
    });
    if (TZ_LIST.indexOf(value) === -1) { var o2 = document.createElement("option"); o2.value = value; o2.textContent = value; sel.appendChild(o2); }
    sel.value = value;
  }

  function findEvent(id) { for (var i = 0; i < state.events.length; i++) if (state.events[i].id === id) return state.events[i]; return null; }

  function renderSummary() {
    var s = $("#summary");
    s.textContent = "";
    var evs = state.events;
    if (!evs.length) return;
    var days = {};
    evs.forEach(function (e) { days[e.date] = true; });
    var dayKeys = Object.keys(days).sort();
    var p1 = document.createElement("p");
    var head = evs.length === 1 ? "Found 1 event" : "Found " + evs.length + " events";
    head += dayKeys.length === 1 ? " on " + longDate(dayKeys[0]) + "." : " across " + dayKeys.length + " days.";
    p1.appendChild(document.createTextNode(head + " Nothing has been added yet \u2014 check the guesses, then tap a button."));
    s.appendChild(p1);
    var ul = document.createElement("ul");
    evs.forEach(function (e) {
      var li = document.createElement("li");
      li.textContent = describe(e) + " \u2014 " + e.title + (e.location ? " at " + e.location : "");
      ul.appendChild(li);
    });
    s.appendChild(ul);
    if (state.phrases && state.phrases.length) {
      var p2 = document.createElement("p"); p2.className = "muted";
      p2.textContent = "Date/time phrases found: " + state.phrases.map(function (t) { return "\u201c" + t + "\u201d"; }).join(", ");
      s.appendChild(p2);
    }
  }

  function renderAllRow() {
    var row = $("#allrow");
    row.hidden = state.events.length < 2;
    $("#all-share").hidden = !canShareFiles;
    var list = $("#all-google-list");
    list.textContent = "";
    state.events.forEach(function (ev) {
      var li = document.createElement("li");
      var a = document.createElement("a");
      a.href = googleUrl(ev); a.target = "_blank"; a.rel = "noopener";
      a.textContent = ev.title + " \u2014 " + describe(ev);
      li.appendChild(a); list.appendChild(li);
    });
  }

  function renderCards() {
    var wrap = $("#cards");
    wrap.textContent = "";
    var tpl = $("#card-tpl");
    state.events.forEach(function (ev) {
      var node = tpl.content.firstElementChild.cloneNode(true);
      node.dataset.id = ev.id;
      updateCard(node, ev, true);
      wrap.appendChild(node);
    });
    $("#result").hidden = state.events.length === 0;
  }

  function updateCard(node, ev, full) {
    $(".when", node).textContent = describe(ev) + (ev.allDay ? "" : " \u00b7 " + ev.tz);
    if (full) {
      $(".f-title", node).value = ev.title;
      $(".f-date", node).value = ev.date;
      $(".f-allday", node).checked = ev.allDay;
      $(".f-start", node).value = ev.start;
      $(".f-end", node).value = ev.end;
      $(".f-enddate", node).value = ev.endDate || ev.date;
      fillTzSelect($(".f-tz", node), ev.tz);
      $(".f-loc", node).value = ev.location;
      $(".f-notes", node).value = ev.notes;
      $(".src", node).textContent = "From: \u201c" + ev.sourceText + "\u201d";
      var flags = $(".flags", node);
      flags.textContent = "";
      ev.flags.forEach(function (f) { var li = document.createElement("li"); li.textContent = f; flags.appendChild(li); });
      flags.hidden = !ev.flags.length;
      $(".share", node).hidden = !canShareFiles;
    }
    $(".tag-title", node).hidden = !ev.titleGuessed;
    var tagLoc = $(".tag-loc", node);
    tagLoc.hidden = !(ev.locationGuessed && ev.location);
    tagLoc.title = ev.locationWhy || "";
    node.querySelectorAll(".timed").forEach(function (el) { el.hidden = ev.allDay; });
    var multi = ev.endDate && ev.endDate !== ev.date;
    $(".enddate", node).hidden = !(ev.allDay || multi);
    $(".google", node).href = googleUrl(ev);
  }

  function onCardInput(e) {
    var node = e.target.closest(".card"); if (!node) return;
    var ev = findEvent(node.dataset.id); if (!ev) return;
    var t = e.target;
    if (t.classList.contains("f-title")) { ev.title = t.value; ev.titleGuessed = false; }
    else if (t.classList.contains("f-date")) {
      if (t.value) { var wasSame = ev.endDate === ev.date; ev.date = t.value; if (wasSame || ev.endDate < ev.date) ev.endDate = ev.date; $(".f-enddate", node).value = ev.endDate; }
    }
    else if (t.classList.contains("f-allday")) {
      ev.allDay = t.checked;
      if (!ev.allDay && !ev.start) { ev.start = "09:00"; ev.end = "10:00"; $(".f-start", node).value = ev.start; $(".f-end", node).value = ev.end; }
    }
    else if (t.classList.contains("f-start")) {
      if (t.value) {
        var oldStart = ev.start; ev.start = t.value;
        if (oldStart && ev.end) { // keep the duration
          var dur = minutesOf(ev.end) - minutesOf(oldStart); if (ev.endDate > ev.date) dur += 1440;
          if (dur > 0) { var r = addMinutes(ev.date, ev.start, dur); ev.end = r.time; ev.endDate = r.date; $(".f-end", node).value = ev.end; $(".f-enddate", node).value = ev.endDate; }
        }
      }
    }
    else if (t.classList.contains("f-end")) {
      if (t.value) { ev.end = t.value; if (minutesOf(ev.end) <= minutesOf(ev.start) && ev.endDate === ev.date) { ev.endDate = addDays(ev.date, 1); $(".f-enddate", node).value = ev.endDate; toast("End is before start, so it ends the next day."); } else if (minutesOf(ev.end) > minutesOf(ev.start) && ev.endDate > ev.date) { ev.endDate = ev.date; $(".f-enddate", node).value = ev.endDate; } }
    }
    else if (t.classList.contains("f-enddate")) { if (t.value) ev.endDate = t.value < ev.date ? ev.date : t.value; }
    else if (t.classList.contains("f-tz")) { ev.tz = t.value; }
    else if (t.classList.contains("f-loc")) { ev.location = t.value; ev.locationGuessed = false; }
    else if (t.classList.contains("f-notes")) { ev.notes = t.value; }
    updateCard(node, ev, false);
    renderSummary();
    renderAllRow();
  }

  function onCardClick(e) {
    var node = e.target.closest(".card"); if (!node) return;
    var ev = findEvent(node.dataset.id); if (!ev) return;
    var t = e.target.closest("a, button"); if (!t) return;
    if (t.classList.contains("del")) {
      state.events = state.events.filter(function (x) { return x.id !== ev.id; });
      node.remove();
      renderSummary(); renderAllRow();
      if (!state.events.length) { $("#result").hidden = true; $("#empty").hidden = false; $("#empty").textContent = "All cards deleted. Paste a message and tap Find events to start again."; }
      return;
    }
    if (t.classList.contains("ios")) { t.href = icsHref([ev]); return; /* let the link open */ }
    if (t.classList.contains("share")) { e.preventDefault(); shareIcs([ev]); return; }
  }

  function run() {
    var text = $("#msg").value;
    state.text = text;
    $("#empty").hidden = true;
    try { localStorage.setItem("quickcal.lastText", text); } catch (e) { /* ignore */ }
    if (!text.trim()) { $("#result").hidden = true; $("#empty").hidden = false; $("#empty").textContent = "Paste a message first."; return; }
    var parsed;
    try { parsed = parseMessage(text, new Date(), { tz: DEVICE_TZ }); }
    catch (err) { $("#result").hidden = true; $("#empty").hidden = false; $("#empty").textContent = "Something went wrong while reading the message: " + err.message; return; }
    state.events = parsed.events; state.phrases = parsed.phrases; state.title = parsed.title;
    if (!parsed.events.length) {
      $("#result").hidden = true; $("#empty").hidden = false;
      $("#empty").textContent = "No dates or times found in that message, so nothing was created. Try adding a date like \u201cSep 16\u201d or a time like \u201c3pm\u201d.";
      return;
    }
    renderCards(); renderSummary(); renderAllRow();
    $("#result").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function init() {
    $("#find").addEventListener("click", run);
    $("#clear").addEventListener("click", function () {
      $("#msg").value = ""; state.events = []; $("#result").hidden = true; $("#empty").hidden = true; $("#cards").textContent = "";
      try { localStorage.removeItem("quickcal.lastText"); } catch (e) { /* ignore */ }
      $("#msg").focus();
    });
    var pasteBtn = $("#paste");
    if (navigator.clipboard && navigator.clipboard.readText) {
      pasteBtn.addEventListener("click", function () {
        navigator.clipboard.readText().then(function (t) { if (t) { $("#msg").value = t; run(); } else toast("Clipboard is empty."); })
          .catch(function () { toast("Could not read the clipboard. Long-press the box and choose Paste instead."); });
      });
    } else { pasteBtn.hidden = true; }

    $("#cards").addEventListener("input", onCardInput);
    $("#cards").addEventListener("change", onCardInput);
    $("#cards").addEventListener("click", onCardClick);

    $("#all-ios").addEventListener("click", function (e) { e.currentTarget.href = icsHref(state.events); });
    $("#all-share").addEventListener("click", function () { shareIcs(state.events); });
    $("#all-google").addEventListener("click", function () { var l = $("#all-google-list"); l.hidden = !l.hidden; });

    var iosSel = $("#set-ios-method"); iosSel.value = settings.iosMethod;
    iosSel.addEventListener("change", function () { settings.iosMethod = iosSel.value; saveSettings(); });
    var icsSel = $("#set-ics-time"); icsSel.value = settings.icsTime;
    icsSel.addEventListener("change", function () { settings.icsTime = icsSel.value; saveSettings(); });

    $("#env-tz").textContent = DEVICE_TZ;
    $("#env-share").textContent = canShareFiles ? "yes" : "no";
    var standalone = (navigator.standalone === true) || (global.matchMedia && matchMedia("(display-mode: standalone)").matches);
    $("#env-standalone").textContent = standalone ? "yes (Home Screen)" : "no (browser tab)";
    $("#env-version").textContent = APP_VERSION + " \u00b7 chrono-node 2.10.1";
    $("#env-ua").textContent = navigator.userAgent;

    try { var last = localStorage.getItem("quickcal.lastText"); if (last) $("#msg").value = last; } catch (e) { /* ignore */ }
    if (!global.chrono) { $("#empty").hidden = false; $("#empty").textContent = "The date parser (vendor/chrono-en.min.js) did not load. Check the file is next to index.html."; }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})(typeof window !== "undefined" ? window : globalThis);
