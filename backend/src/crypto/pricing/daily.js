'use strict';

// Everything here is UTC and date-only. A price row is keyed by a DATE, so a
// local-timezone Date.toISOString() slice would silently shift a whole series
// by a day for anyone west of Greenwich.

function toDateString(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function dateToUnix(dateString) {
  return Math.floor(Date.parse(`${toDateString(dateString)}T00:00:00Z`) / 1000);
}

function addDays(dateString, days) {
  const at = Date.parse(`${toDateString(dateString)}T00:00:00Z`) + days * 86400000;
  return new Date(at).toISOString().slice(0, 10);
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function maxDate(a, b) {
  return toDateString(a) >= toDateString(b) ? toDateString(a) : toDateString(b);
}

// THE DAILY CONVENTION, in one function.
//
// The stored price for date D is the LAST observation the provider reported
// with a timestamp inside D (UTC). Uniform across providers and granularities:
//
//   * CoinGecko above a 90-day span emits one point per day stamped 00:00:00
//     UTC, so D's stored price is that snapshot -- CoinGecko's own convention,
//     the same one its /coins/{id}/history?date= endpoint uses.
//   * CoinGecko inside 90 days emits hourly points, so D's stored price is the
//     23:00 observation -- a true daily close.
//   * Coinbase emits one candle per day whose `close` IS D's close.
//   * Bitfinex emits one candle per day whose MTS is the UTC-midnight bucket
//     START (in milliseconds) and whose index 2 is that day's close --
//     verified live, so the fold's "last observation inside D" lands each
//     close on the day it belongs to.
//
// The spread between those readings is one day's intraday movement on a series
// whose whole resolution is one day. Each row records its `source`, so a
// provider switch mid-series is visible rather than inferred.
function foldToDailyClose(observations) {
  const byDate = new Map();
  for (const [timestampMs, price] of observations) {
    // null and '' both coerce to 0 through Number(), which would store a
    // fabricated $0 close for a gap the provider reported as "no data" -- the
    // exact silent-zero this feature exists to remove. Reject them by identity
    // before any coercion.
    if (price === null || price === undefined || price === '') continue;
    const value = Number(price);
    if (!Number.isFinite(value) || value < 0) continue;
    if (!Number.isFinite(Number(timestampMs))) continue;
    const date = new Date(Number(timestampMs)).toISOString().slice(0, 10);
    const existing = byDate.get(date);
    if (!existing || Number(timestampMs) >= existing.at) {
      byDate.set(date, { at: Number(timestampMs), price: value });
    }
  }
  return [...byDate.entries()]
    .map(([date, entry]) => ({ date, price: entry.price }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

module.exports = { toDateString, dateToUnix, addDays, todayUtc, maxDate, foldToDailyClose };
