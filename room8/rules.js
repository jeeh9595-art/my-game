/* =============================================================
   8호실 · 규칙 엔진
   -------------------------------------------------------------
   화면·네트워크와 완전히 분리된 순수 로직.
   DOM, three.js, PeerJS 를 일절 참조하지 않는다.
   나중에 다른 엔진으로 옮길 때 이 파일만 번역하면 된다.
============================================================= */
(function (root) {
"use strict";

var R = {};

/* ---------- 설정값 ---------- */
R.SLOTS  = 4;      // 자물쇠 칸 수 = 라운드 수
R.ROUNDS = 4;
R.MIN_PLAYERS = 3;
R.MAX_PLAYERS = 8;

R.TIME = { theme: 40, words: 70, night: 100, day: 150, vote: 35, final: 80 };

R.THEMES = ["동물", "음식", "가전제품", "탈것", "직업", "스포츠", "학용품", "과일"];

/* ---------- 잡동사니 ---------- */
function shuffle(a, rnd) {
  a = a.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(rnd() * (i + 1)), t = a[i];
    a[i] = a[j]; a[j] = t;
  }
  return a;
}
R.shuffle = shuffle;

/* ---------- 배신자 수 ---------- */
R.traitorCount = function (n) {
  if (n >= 7) return 2;
  return 1;
};

/* 탈출 실패 몇 명부터 배신자 승리인가 */
R.failThreshold = function (n) {
  if (n >= 7) return 3;
  if (n >= 5) return 2;
  return 1;
};

/* ---------- 역할 배정 ---------- */
R.assignRoles = function (n, rnd) {
  var idx = shuffle(range(n), rnd);
  var k = R.traitorCount(n);
  var roles = [];
  for (var i = 0; i < n; i++) roles.push("citizen");
  for (var j = 0; j < k && j < idx.length; j++) roles[idx[j]] = "traitor";
  return roles;
};

function range(n) { var a = []; for (var i = 0; i < n; i++) a.push(i); return a; }
R.range = range;

/* ---------- 단어판 ----------
   submissions: [[단어1, 단어2], ...] 플레이어 순서대로
   반환: [{text, owner}]  ·  중복이 있으면 {error} */
R.buildBoard = function (submissions) {
  var words = [], seen = {};
  for (var i = 0; i < submissions.length; i++) {
    var pair = submissions[i] || [];
    for (var k = 0; k < pair.length; k++) {
      var w = String(pair[k] || "").trim();
      if (!w) return { error: "빈 단어", who: i };
      if (seen[w] !== undefined) return { error: "중복된 단어: " + w, who: i };
      seen[w] = true;
      words.push({ text: w, owner: i });
    }
  }
  return { words: words };
};

/* ---------- 자물쇠 ----------
   규칙 1. 자기가 낸 단어는 자기 자물쇠에 들어가지 않는다
   규칙 2. 한 자물쇠에 같은 사람이 낸 단어가 두 개 들어가지 않는다
   반환: locks[playerIdx] = [wordIdx x SLOTS] */
R.buildLocks = function (n, words, rnd) {
  var byOwner = {};
  words.forEach(function (w, wi) {
    (byOwner[w.owner] = byOwner[w.owner] || []).push(wi);
  });

  var locks = [];
  for (var p = 0; p < n; p++) {
    var others = range(n).filter(function (o) { return o !== p && byOwner[o] && byOwner[o].length; });
    var owners = shuffle(others, rnd);

    // 사람이 부족하면(테스트용 소인원) 같은 사람 단어를 다시 쓸 수밖에 없다
    while (owners.length < R.SLOTS && others.length) {
      owners = owners.concat(shuffle(others, rnd));
    }
    owners = owners.slice(0, R.SLOTS);

    var lock = owners.map(function (o) {
      var pool = byOwner[o];
      return pool[Math.floor(rnd() * pool.length)];
    });
    // 같은 단어가 두 번 들어가는 것만은 막는다
    var used = {}, ok = [];
    lock.forEach(function (wi) {
      if (used[wi]) {
        var alt = words.map(function (_, i) { return i; })
          .filter(function (i) { return !used[i] && words[i].owner !== p; });
        wi = alt.length ? alt[Math.floor(rnd() * alt.length)] : wi;
      }
      used[wi] = true; ok.push(wi);
    });
    locks.push(shuffle(ok, rnd));
  }
  return locks;
};

/* ---------- 라운드별 담당 ----------
   매 라운드 새로 섞는다. 자기 자신은 담당하지 않는다.
   반환: miss[round][보내는사람] = 받는사람 */
R.buildAssignments = function (n, rounds, rnd) {
  var out = [];
  for (var r = 0; r < rounds; r++) out.push(derangement(n, rnd));
  return out;
};

function derangement(n, rnd) {
  if (n < 2) return [0];
  for (var t = 0; t < 500; t++) {
    var p = shuffle(range(n), rnd), ok = true;
    for (var i = 0; i < n; i++) if (p[i] === i) { ok = false; break; }
    if (ok) return p;
  }
  return range(n).map(function (i) { return (i + 1) % n; });
}
R.derangement = derangement;

/* ---------- 이번 라운드에 실제로 활동하는가 ---------- */
R.isActive = function (player, round) {
  return !player.dead && player.isoRound !== round;
};

/* ---------- 밤 배달 ----------
   players: [{dead, isoRound, recv}]
   assign:  이번 라운드 담당 배열
   draws:   {보내는사람idx: strokes}
   locks:   자물쇠
   round:   1부터
   각 수신자의 recv 에 {round, from, wordIdx, strokes} 를 밀어넣는다. */
R.deliver = function (players, assign, draws, locks, round) {
  var slot = round - 1, log = [];
  for (var i = 0; i < players.length; i++) {
    if (!R.isActive(players[i], round)) continue;
    var to = assign[i];
    if (to === undefined || to === null) continue;
    if (!R.isActive(players[to], round)) continue;
    var d = draws ? draws[i] : null;
    players[to].recv.push({
      round: round, from: i, slot: slot,
      trueWord: locks[to][slot],
      strokes: d ? d : null
    });
    log.push({ from: i, to: to, slot: slot, drew: !!d });
  }
  return log;
};

/* ---------- 투표 집계 ----------
   votes: {투표자idx: 대상idx}  (-1 = 기권)
   반환: {target, count, tie, tally} */
R.tally = function (votes) {
  var tally = {};
  Object.keys(votes).forEach(function (k) {
    var v = votes[k];
    if (v === undefined || v === null || v < 0) return;
    tally[v] = (tally[v] || 0) + 1;
  });
  var best = -1, bn = 0, tie = false;
  Object.keys(tally).forEach(function (k) {
    if (tally[k] > bn) { bn = tally[k]; best = parseInt(k, 10); tie = false; }
    else if (tally[k] === bn) { tie = true; }
  });
  return { target: (best >= 0 && !tie) ? best : -1, count: bn, tie: tie, tally: tally };
};

/* ---------- 독방 처리 ----------
   반환: {kind:"none"|"isolated"|"eliminated", target} */
R.isolate = function (players, target, round) {
  if (target < 0 || !players[target]) return { kind: "none", target: -1 };
  var p = players[target];
  p.iso = (p.iso || 0) + 1;
  p.isoRound = round + 1;
  if (p.iso >= 2) { p.dead = true; return { kind: "eliminated", target: target }; }
  return { kind: "isolated", target: target };
};

/* ---------- 판정 ---------- */
R.judge = function (players, locks, words) {
  var n = players.length, need = R.failThreshold(n);
  var rows = players.map(function (p, i) {
    var esc = false;
    if (!p.dead && p.answer && p.answer.length === R.SLOTS) {
      esc = true;
      for (var k = 0; k < R.SLOTS; k++) if (p.answer[k] !== locks[i][k]) { esc = false; break; }
    }
    p.escaped = esc;
    return {
      idx: i, name: p.name, role: p.role, dead: !!p.dead, escaped: esc,
      answer: p.answer ? p.answer.map(function (wi) { return words[wi].text; }) : null,
      lock: locks[i].map(function (wi) { return words[wi].text; }),
      wrong: p.answer ? p.answer.map(function (wi, k) {
        return wi === locks[i][k] ? null : (k + 1);
      }).filter(function (x) { return x !== null; }) : []
    };
  });
  var failed = rows.filter(function (r) { return !r.escaped; }).length;
  return {
    win: failed >= need ? "traitor" : "citizen",
    failed: failed, need: need, rows: rows,
    traitors: players.map(function (p, i) { return p.role === "traitor" ? p.name : null; })
                     .filter(Boolean)
  };
};

/* ---------- 자기 점검: 같은 사람 단어가 둘인가 ---------- */
R.duplicateOwner = function (picks, words) {
  var own = {};
  for (var k = 0; k < picks.length; k++) {
    var wi = picks[k];
    if (wi === undefined || wi === null || wi < 0) continue;
    var o = words[wi].owner;
    if (own[o] !== undefined) return { a: own[o], b: k, owner: o };
    own[o] = k;
  }
  return null;
};

/* ---------- 페이즈 진행 순서 ---------- */
R.nextPhase = function (phase, round) {
  switch (phase) {
    case "lobby":  return { phase: "theme", round: 0 };
    case "theme":  return { phase: "words", round: 0 };
    case "words":  return { phase: "night", round: 1 };
    case "night":  return { phase: "day",   round: round };
    case "day":    return { phase: "vote",  round: round };
    case "vote":   return round >= R.ROUNDS
                        ? { phase: "final", round: round }
                        : { phase: "night", round: round + 1 };
    case "final":  return { phase: "result", round: round };
    default:       return { phase: phase, round: round };
  }
};

if (typeof module !== "undefined" && module.exports) module.exports = R;
root.Room8Rules = R;

})(typeof window !== "undefined" ? window : this);
