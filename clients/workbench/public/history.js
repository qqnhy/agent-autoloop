// Ordering and labels for the chat timeline: an entry with no recorded time stays last instead of becoming 1970.
"use strict";
globalThis.chatHistory = (() => {
  const stamp = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const millis = new Date(value).getTime();
    return Number.isNaN(millis) ? null : millis;
  };
  const time = (value) => {
    if (stamp(value) === null) return value === null || value === undefined || value === "" ? "未记录" : "时间未知";
    return new Date(value).toLocaleString("zh-CN", { hour12: false });
  };
  const runAt = (run) => run.reply?.at || run.finishedAt || run.claimedAt || run.createdAt || null;
  const sort = (entries) =>
    [...entries].sort((left, right) => {
      const a = stamp(left.at);
      const b = stamp(right.at);
      if (a === null) return b === null ? 0 : 1;
      if (b === null) return -1;
      return a - b;
    });
  return { time, runAt, sort };
})();
