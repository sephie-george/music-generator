import type { Chop, PatternTemplate } from "../types";
import { classifyChop } from "./transient-detector";

interface PatternResult {
  pattern: number[][]; // 16 tracks × 32 steps
  trackAssignments: number[]; // which chop each track uses
  bpm: number; // randomized BPM
}

// Utility: weighted random choice
function weightedPick(weights: number[]): number {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

// Euclidean rhythm: distribute N hits across M steps
function euclidean(hits: number, steps: number): boolean[] {
  const pattern: boolean[] = Array(steps).fill(false);
  if (hits <= 0) return pattern;
  if (hits >= steps) return Array(steps).fill(true);

  for (let i = 0; i < hits; i++) {
    const pos = Math.floor((i * steps) / hits);
    pattern[pos] = true;
  }
  return pattern;
}

// Humanize: randomly skip some hits for more natural feel
function humanize(row: number[], skipProb: number): number[] {
  return row.map((v) => (v >= 0 && Math.random() < skipProb ? -1 : v));
}

// Remove parallel notes: keep only one note per step (random track wins)
function deduplicateSteps(pattern: number[][], steps: number): void {
  for (let s = 0; s < steps; s++) {
    const activeTracks: number[] = [];
    for (let t = 0; t < pattern.length; t++) {
      if (pattern[t][s] >= 0) activeTracks.push(t);
    }
    if (activeTracks.length > 1) {
      // Keep one random track, clear the rest
      const keeper = activeTracks[Math.floor(Math.random() * activeTracks.length)];
      for (const t of activeTracks) {
        if (t !== keeper) pattern[t][s] = -1;
      }
    }
  }
}

// Random BPM between 60-120
function randomBpm(): number {
  return 60 + Math.floor(Math.random() * 61);
}

// Shift pattern by N steps (rotation)
function rotate(row: number[], offset: number, steps: number): number[] {
  const result = Array(steps).fill(-1);
  for (let i = 0; i < steps; i++) {
    const src = ((i - offset) % steps + steps) % steps;
    result[i] = row[src];
  }
  return result;
}

export function generatePattern(
  chops: Chop[],
  template: PatternTemplate,
  steps: number = 32
): PatternResult {
  if (chops.length === 0) {
    return {
      pattern: Array.from({ length: 16 }, () => Array(steps).fill(-1)),
      trackAssignments: Array(16).fill(-1),
      bpm: randomBpm(),
    };
  }

  const lowChops = chops.filter((c) => classifyChop(c) === "low");
  const midChops = chops.filter((c) => classifyChop(c) === "mid");
  const highChops = chops.filter((c) => classifyChop(c) === "high");

  const pick = (arr: Chop[], fallback: Chop[]) =>
    arr.length > 0 ? arr : fallback.length > 0 ? fallback : chops;

  const lows = pick(lowChops, chops);
  const mids = pick(midChops, chops);
  const highs = pick(highChops, chops);

  const randFrom = (arr: Chop[]) => arr[Math.floor(Math.random() * arr.length)];

  const pattern: number[][] = Array.from({ length: 16 }, () => Array(steps).fill(-1));
  const trackAssignments: number[] = Array(16).fill(-1);

  const assign = (track: number, chop: Chop) => {
    trackAssignments[track] = chop.index;
  };

  const fillRow = (track: number, chopIdx: number, positions: number[]) => {
    for (const s of positions) {
      if (s >= 0 && s < steps) pattern[track][s] = chopIdx;
    }
  };

  const fillEuclidean = (track: number, chopIdx: number, hits: number, offset = 0) => {
    const euc = euclidean(hits, steps);
    for (let i = 0; i < steps; i++) {
      const shifted = ((i - offset) % steps + steps) % steps;
      if (euc[shifted]) pattern[track][i] = chopIdx;
    }
  };

  switch (template) {
    case "basic": {
      // Layered groove with swing feel
      const kick = randFrom(lows);
      const snare = randFrom(mids);
      const hat = randFrom(highs);
      const perc = randFrom(chops.filter((c) => c !== kick && c !== snare) || chops);
      const ghost = randFrom(mids.length > 1 ? mids.filter((c) => c !== snare) : chops);

      assign(0, kick);
      assign(1, snare);
      assign(2, hat);
      assign(3, perc);
      assign(4, ghost);

      // Kick: main beats + variation
      const kickVariations = [
        [0, 10, 16, 26],           // straight with push
        [0, 6, 16, 22],            // syncopated
        [0, 10, 14, 16, 26, 30],   // busy
        [0, 3, 10, 16, 19, 26],    // triplet feel
      ];
      fillRow(0, kick.index, kickVariations[Math.floor(Math.random() * kickVariations.length)]);

      // Snare: backbeat + ghost notes
      fillRow(1, snare.index, [8, 24]);
      // Ghost snares
      const ghostPositions = [4, 12, 20, 28].filter(() => Math.random() > 0.4);
      fillRow(4, ghost.index, ghostPositions);
      pattern[4] = humanize(pattern[4], 0.3);

      // Hats: euclidean with gaps
      const hatDensity = [5, 7, 9, 11, 13][Math.floor(Math.random() * 5)];
      fillEuclidean(2, hat.index, hatDensity, Math.floor(Math.random() * 3));
      pattern[2] = humanize(pattern[2], 0.1);

      // Perc: sparse accents on off-beats
      const percEuc = euclidean(3 + Math.floor(Math.random() * 4), steps);
      for (let i = 0; i < steps; i++) {
        if (percEuc[i] && i % 4 !== 0) pattern[3][i] = perc.index;
      }
      break;
    }

    case "syncopated": {
      const kick = randFrom(lows);
      const snare = randFrom(mids);
      const hat = randFrom(highs);
      const rim = randFrom(mids.filter((c) => c !== snare) || chops);
      const perc1 = randFrom(chops);
      const perc2 = randFrom(chops.filter((c) => c !== perc1) || chops);

      assign(0, kick);
      assign(1, snare);
      assign(2, hat);
      assign(3, rim);
      assign(4, perc1);
      assign(5, perc2);

      // Kick: heavy syncopation with rests
      const kickRhythm = euclidean(5 + Math.floor(Math.random() * 3), steps);
      for (let i = 0; i < steps; i++) {
        // Avoid kick on snare hits, push them off-grid
        if (kickRhythm[i] && i !== 8 && i !== 24) {
          pattern[0][i] = kick.index;
        }
      }
      // Ensure downbeat
      pattern[0][0] = kick.index;

      // Snare: displaced backbeat
      const snareOffset = Math.random() > 0.5 ? 1 : 0; // flamming
      fillRow(1, snare.index, [8 + snareOffset, 24 + snareOffset]);

      // Hats: broken pattern
      for (let i = 0; i < steps; i++) {
        const prob = (i % 2 === 0) ? 0.7 : 0.3;
        if (Math.random() < prob) pattern[2][i] = hat.index;
      }
      // Open hat gaps
      for (const s of [7, 15, 23, 31]) {
        if (s < steps) {
          pattern[2][s] = -1; // gap before beat
        }
      }

      // Rim: counter-rhythm euclidean
      fillEuclidean(3, rim.index, 5, 2);
      pattern[3] = humanize(pattern[3], 0.25);

      // Percussion layers: polyrhythmic
      fillEuclidean(4, perc1.index, 3, 1);
      fillEuclidean(5, perc2.index, 7, 3);
      pattern[5] = humanize(pattern[5], 0.4);
      break;
    }

    case "breakbeat": {
      const kick = randFrom(lows);
      const snare = randFrom(mids);
      const hat = randFrom(highs);
      const ghost = randFrom(mids.length > 1 ? mids.filter((c) => c !== snare) : chops);
      const crash = randFrom(highs.filter((c) => c !== hat) || chops);
      const perc = randFrom(chops);

      assign(0, kick);
      assign(1, snare);
      assign(2, hat);
      assign(3, ghost);
      assign(4, crash);
      assign(5, perc);

      // Amen-style breaks with variations
      const breakPatterns = [
        // Amen
        { kick: [0, 10, 16, 20, 26], snare: [4, 8, 14, 20, 24, 30] },
        // Think
        { kick: [0, 4, 10, 16, 20, 26], snare: [8, 14, 24, 30] },
        // Funky Drummer
        { kick: [0, 8, 10, 16, 24, 26], snare: [4, 12, 20, 28] },
        // Apache
        { kick: [0, 6, 10, 16, 22, 26], snare: [4, 14, 20, 30] },
      ];
      const bp = breakPatterns[Math.floor(Math.random() * breakPatterns.length)];
      fillRow(0, kick.index, bp.kick);
      fillRow(1, snare.index, bp.snare);

      // Fast hats with open/closed variation
      for (let i = 0; i < steps; i++) {
        if (Math.random() > 0.15) pattern[2][i] = hat.index;
      }

      // Ghost snares between main hits
      for (let i = 0; i < steps; i++) {
        if (pattern[1][i] < 0 && pattern[0][i] < 0 && Math.random() < 0.2) {
          pattern[3][i] = ghost.index;
        }
      }

      // Crash on 1
      pattern[4][0] = crash.index;
      if (Math.random() > 0.5) pattern[4][16] = crash.index;

      // Fills: random rolls at end of phrase
      for (let i = 28; i < steps; i++) {
        if (Math.random() < 0.5) pattern[5][i] = perc.index;
      }
      break;
    }

    case "halftime": {
      const kick = randFrom(lows);
      const snare = randFrom(mids);
      const hat = randFrom(highs);
      const sub = randFrom(lows.filter((c) => c !== kick) || chops);
      const texture = randFrom(chops);

      assign(0, kick);
      assign(1, snare);
      assign(2, hat);
      assign(3, sub);
      assign(4, texture);

      // Deep halftime: very sparse
      pattern[0][0] = kick.index;
      if (Math.random() > 0.3) pattern[0][22] = kick.index;
      if (Math.random() > 0.5) pattern[0][28] = kick.index;

      // Snare only on 3
      pattern[1][16] = snare.index;

      // Hats: slow euclidean
      fillEuclidean(2, hat.index, 4 + Math.floor(Math.random() * 3));
      pattern[2] = humanize(pattern[2], 0.15);

      // Sub hits: off-grid
      fillRow(3, sub.index, [6, 14].filter(() => Math.random() > 0.3));

      // Textural layer: very sparse, random
      for (let i = 0; i < steps; i++) {
        if (Math.random() < 0.08) pattern[4][i] = texture.index;
      }
      break;
    }

    case "random": {
      // Generative: use euclidean rhythms with different densities per track
      const numTracks = Math.min(chops.length, 8);
      const usedChops = [...chops].sort(() => Math.random() - 0.5).slice(0, numTracks);

      usedChops.forEach((chop, i) => {
        assign(i, chop);

        // Each track gets a different euclidean density + offset
        const density = 2 + Math.floor(Math.random() * (steps / 2));
        const offset = Math.floor(Math.random() * steps);
        fillEuclidean(i, chop.index, density, offset);

        // Variable humanization
        pattern[i] = humanize(pattern[i], 0.1 + Math.random() * 0.3);
      });

      // Add some structural anchoring: ensure something on beat 1
      if (pattern[0][0] < 0 && usedChops.length > 0) {
        pattern[0][0] = usedChops[0].index;
      }
      break;
    }
  }

  // Fill remaining unassigned tracks (6-15) with varied percussion
  const usedIndices = new Set(trackAssignments.filter((v) => v >= 0));
  for (let t = 0; t < 16; t++) {
    if (trackAssignments[t] >= 0) continue;
    // Pick a chop not yet used (or random if all used)
    const available = chops.filter((c) => !usedIndices.has(c.index));
    const chop = available.length > 0
      ? available[Math.floor(Math.random() * available.length)]
      : chops[Math.floor(Math.random() * chops.length)];
    trackAssignments[t] = chop.index;
    usedIndices.add(chop.index);

    // Give each a euclidean pattern with random density and offset
    const hits = 1 + Math.floor(Math.random() * 6);
    const offset = Math.floor(Math.random() * steps);
    const euc = euclidean(hits, steps);
    for (let i = 0; i < steps; i++) {
      const shifted = ((i - offset) % steps + steps) % steps;
      if (euc[shifted]) pattern[t][i] = chop.index;
    }
    pattern[t] = humanize(pattern[t], 0.15 + Math.random() * 0.2);
  }

  deduplicateSteps(pattern, steps);
  return { pattern, trackAssignments, bpm: randomBpm() };
}

// Text-prompt-based generation — uses ALL 16 tracks
export function generateFromPrompt(
  chops: Chop[],
  prompt: string,
  steps: number = 32
): PatternResult {
  const p = prompt.toLowerCase();

  // Parse keywords
  const sparse = /sparse|minimal|less|empty|simple|chill|ambient/.test(p);
  const dense = /dense|busy|full|complex|crazy|chaos|maximal/.test(p);
  const fast = /fast|rapid|quick|16th|roll/.test(p);
  const slow = /slow|half|laid.?back|downtempo/.test(p);
  const heavyKick = /heavy.?kick|808|bass|boom|sub|deep/.test(p);
  const noKick = /no.?kick/.test(p);
  const trap = /trap|hi.?hat|triplet/.test(p);
  const dnb = /dnb|drum.?n|jungle|170|breakcore/.test(p);
  const swing = /swing|shuffle|groove|bounce|funk/.test(p);
  const polyrhythm = /poly|cross|odd|5\/4|7\/8|african|afro/.test(p);
  const fill = /fill|roll|build|riser/.test(p);
  const hatOnly = /hat.?only|hats.?only|percussion.?only/.test(p);
  const snareRush = /snare.?rush|snare.?roll|snare.?fill/.test(p);
  const glitch = /glitch|stutter|chop|slice|IDM|autechre/.test(p);
  const dub = /dub|reggae|offbeat|ska/.test(p);
  const latin = /latin|bossa|samba|rumba|clave/.test(p);
  const industrial = /industrial|noise|harsh|techno|gabber/.test(p);

  // Classify all chops
  const lowChops = chops.filter((c) => classifyChop(c) === "low");
  const midChops = chops.filter((c) => classifyChop(c) === "mid");
  const highChops = chops.filter((c) => classifyChop(c) === "high");
  const pick = (arr: Chop[], fb: Chop[]) => arr.length > 0 ? arr : fb.length > 0 ? fb : chops;
  const lows = pick(lowChops, chops);
  const mids = pick(midChops, chops);
  const highs = pick(highChops, chops);
  const randFrom = (arr: Chop[]) => arr[Math.floor(Math.random() * arr.length)];
  const uniqueRandFrom = (arr: Chop[], exclude: Set<number>): Chop => {
    const available = arr.filter((c) => !exclude.has(c.index));
    return available.length > 0 ? available[Math.floor(Math.random() * available.length)] : randFrom(arr);
  };

  const pattern: number[][] = Array.from({ length: 16 }, () => Array(steps).fill(-1));
  const trackAssignments: number[] = Array(16).fill(-1);

  const assign = (t: number, c: Chop) => { trackAssignments[t] = c.index; };
  const fillRow = (t: number, idx: number, pos: number[]) => {
    for (const s of pos) if (s >= 0 && s < steps) pattern[t][s] = idx;
  };
  const fillEuc = (t: number, idx: number, hits: number, offset = 0) => {
    const euc = euclidean(hits, steps);
    for (let i = 0; i < steps; i++) {
      const shifted = ((i - offset) % steps + steps) % steps;
      if (euc[shifted]) pattern[t][i] = idx;
    }
  };

  const density = sparse ? 0.4 : dense ? 1.6 : 1.0;
  const used = new Set<number>();

  // Pick unique chops for each role
  const pickUnique = (arr: Chop[]) => {
    const c = uniqueRandFrom(arr, used);
    used.add(c.index);
    return c;
  };

  // === CORE RHYTHM (tracks 0-3) ===
  const kick1 = pickUnique(lows);
  const kick2 = pickUnique(lows);
  const snare1 = pickUnique(mids);
  const snare2 = pickUnique(mids);

  assign(0, kick1);
  assign(1, kick2);
  assign(2, snare1);
  assign(3, snare2);

  // Kick 1: main
  if (!noKick && !hatOnly) {
    if (heavyKick || trap) {
      fillRow(0, kick1.index, [0, 3, 6, 10, 16, 19, 22, 28]);
    } else if (dnb) {
      fillRow(0, kick1.index, [0, 10, 16, 26]);
    } else if (dub) {
      fillRow(0, kick1.index, [0, 8, 16, 24]);
    } else if (latin) {
      fillRow(0, kick1.index, [0, 6, 16, 22]);
    } else if (slow) {
      fillRow(0, kick1.index, [0, 24]);
    } else if (industrial) {
      // Four on the floor
      for (let i = 0; i < steps; i += 4) pattern[0][i] = kick1.index;
    } else {
      const kickPatterns = [
        [0, 10, 16, 26], [0, 6, 16, 22], [0, 10, 14, 16, 26, 30],
        [0, 3, 10, 16, 19, 26], [0, 8, 14, 16, 24, 30],
      ];
      fillRow(0, kick1.index, kickPatterns[Math.floor(Math.random() * kickPatterns.length)]);
    }
    if (sparse) pattern[0] = humanize(pattern[0], 0.3);
  }

  // Kick 2: sub layer / ghost kicks
  if (!noKick && !hatOnly && !sparse) {
    for (let i = 0; i < steps; i++) {
      if (pattern[0][i] < 0 && Math.random() < 0.08 * density) {
        pattern[1][i] = kick2.index;
      }
    }
  }

  // Snare 1: main backbeat
  if (!hatOnly) {
    if (dnb || dub) {
      fillRow(2, snare1.index, [8, 24]);
    } else if (snareRush || fill) {
      fillRow(2, snare1.index, [8]);
      for (let i = 16; i < steps; i++) {
        if (Math.random() < 0.55 * density) pattern[2][i] = snare1.index;
      }
    } else if (slow) {
      fillRow(2, snare1.index, [16]);
    } else if (latin) {
      // Clave-ish
      fillRow(2, snare1.index, [6, 10, 16, 24, 28]);
    } else {
      fillRow(2, snare1.index, [8, 24]);
    }
  }

  // Snare 2: ghost snares
  if (!hatOnly && !sparse) {
    const ghostPositions: number[] = [];
    for (let i = 0; i < steps; i++) {
      if (pattern[2][i] < 0 && pattern[0][i] < 0 && Math.random() < 0.12 * density) {
        ghostPositions.push(i);
      }
    }
    fillRow(3, snare2.index, ghostPositions);
  }

  // === HI-HATS (tracks 4-6) ===
  const hat1 = pickUnique(highs);
  const hat2 = pickUnique(highs);
  const hat3 = pickUnique(highs);
  assign(4, hat1);
  assign(5, hat2);
  assign(6, hat3);

  // Hat 1: closed / main rhythm
  if (trap) {
    for (let i = 0; i < steps; i++) {
      if (Math.random() < 0.45 * density) pattern[4][i] = hat1.index;
    }
    // Rolls at random spots
    for (let r = 0; r < 3; r++) {
      const start = Math.floor(Math.random() * (steps - 4));
      for (let i = start; i < start + 3 + Math.floor(Math.random() * 3); i++) {
        if (i < steps) pattern[4][i] = hat1.index;
      }
    }
  } else if (fast || dense || industrial) {
    for (let i = 0; i < steps; i++) {
      if (Math.random() < 0.7 * density) pattern[4][i] = hat1.index;
    }
  } else if (sparse || slow) {
    for (let i = 0; i < steps; i += 4) pattern[4][i] = hat1.index;
  } else if (dub) {
    // Off-beat hats
    for (let i = 2; i < steps; i += 4) pattern[4][i] = hat1.index;
  } else {
    for (let i = 0; i < steps; i += 2) pattern[4][i] = hat1.index;
    for (let i = 1; i < steps; i += 2) {
      if (Math.random() < 0.2 * density) pattern[4][i] = hat1.index;
    }
  }

  if (swing) {
    for (let i = 0; i < steps; i++) {
      if (i % 4 === 2 && Math.random() < 0.5) pattern[4][i] = -1;
      if (i % 4 === 3 && Math.random() < 0.45) pattern[4][i] = hat1.index;
    }
  }

  // Hat 2: open hat / accent
  if (!sparse) {
    const openPositions = [7, 15, 23, 31].filter(() => Math.random() < 0.6 * density);
    fillRow(5, hat2.index, openPositions);
  }

  // Hat 3: shaker / ride pattern (different rhythm)
  if (dense || polyrhythm || latin) {
    fillEuc(6, hat3.index, 5 + Math.floor(Math.random() * 6), Math.floor(Math.random() * 4));
  } else if (!sparse) {
    for (let i = 0; i < steps; i++) {
      if (Math.random() < 0.1 * density) pattern[6][i] = hat3.index;
    }
  }

  // === PERCUSSION LAYERS (tracks 7-11) ===
  const perc: Chop[] = [];
  for (let i = 7; i <= 11; i++) {
    const c = pickUnique(chops);
    perc.push(c);
    assign(i, c);
  }

  if (polyrhythm) {
    // Different euclidean densities per perc track
    const eucDensities = [3, 5, 7, 9, 11];
    perc.forEach((c, i) => {
      fillEuc(7 + i, c.index, eucDensities[i], Math.floor(Math.random() * steps));
      pattern[7 + i] = humanize(pattern[7 + i], 0.15);
    });
  } else if (glitch) {
    // Stuttery random patterns
    perc.forEach((c, i) => {
      for (let s = 0; s < steps; s++) {
        if (Math.random() < 0.18 * density) pattern[7 + i][s] = c.index;
      }
      // Add micro-bursts
      const burstStart = Math.floor(Math.random() * (steps - 3));
      for (let s = burstStart; s < burstStart + 2 + Math.floor(Math.random() * 3); s++) {
        if (s < steps) pattern[7 + i][s] = c.index;
      }
    });
  } else if (latin) {
    // Conga-like layers
    fillEuc(7, perc[0].index, 7, 1);
    fillEuc(8, perc[1].index, 5, 3);
    fillRow(9, perc[2].index, [0, 6, 10, 16, 22, 28]); // tumbao
    fillEuc(10, perc[3].index, 3, 2);
    for (let i = 0; i < steps; i += 8) pattern[11][i] = perc[4].index; // bell
  } else if (industrial) {
    // Harsh, mechanical patterns
    perc.forEach((c, i) => {
      const interval = 3 + i;
      for (let s = i; s < steps; s += interval) {
        pattern[7 + i][s] = c.index;
      }
    });
  } else {
    // General perc: each track gets a different euclidean density
    perc.forEach((c, i) => {
      const hits = Math.max(1, Math.floor((2 + Math.random() * 5) * density));
      const offset = Math.floor(Math.random() * steps);
      fillEuc(7 + i, c.index, hits, offset);
      pattern[7 + i] = humanize(pattern[7 + i], 0.1 + Math.random() * 0.2);
    });
  }

  // === TEXTURE / ACCENTS (tracks 12-15) ===
  for (let t = 12; t <= 15; t++) {
    const c = pickUnique(chops);
    assign(t, c);

    if (glitch) {
      // Random stutter
      for (let s = 0; s < steps; s++) {
        if (Math.random() < 0.12 * density) pattern[t][s] = c.index;
      }
    } else if (fill && t >= 14) {
      // Build/fill in last 8 steps
      for (let s = steps - 8; s < steps; s++) {
        if (Math.random() < 0.5 * density) pattern[t][s] = c.index;
      }
    } else if (dense) {
      fillEuc(t, c.index, 2 + Math.floor(Math.random() * 4), Math.floor(Math.random() * steps));
    } else if (!sparse) {
      // Very sparse texture
      for (let s = 0; s < steps; s++) {
        if (Math.random() < 0.06 * density) pattern[t][s] = c.index;
      }
    }
    // Sparse: leave these tracks empty (intentional breathing room)
  }

  // Final humanize pass on all tracks
  for (let t = 0; t < 16; t++) {
    pattern[t] = humanize(pattern[t], 0.03 + (t > 6 ? 0.05 : 0));
  }

  deduplicateSteps(pattern, steps);
  return { pattern, trackAssignments, bpm: randomBpm() };
}
