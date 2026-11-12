// Modelo de decolagem de 3 graus de liberdade (x, z, arfagem) com perturbações laterais.
// Não é um simulador de voo completo: o objetivo é gerar trajetórias plausíveis de fim de
// corrida / rotação / subida inicial de uma aeronave de AeroDesign, com vento e rajadas.
import { makeRng, bandNoise, deg, clamp, smoothstep } from './util.js';

const G = 9.80665, RHO = 1.225;

function integrate(cfg, mass, seed) {
  const d = cfg.dynamics, ac = cfg.aircraft, wind = cfg.environment.wind;
  const rng = makeRng(seed * 7919 + 13);
  const S = d.wing_area_m2 ?? ac.wingspan_m * ac.chord_m;
  const W = mass * G;
  const L = cfg.runway.length_m;

  // Vento: componente de proa (contra o movimento) e de través.
  const wdir = deg(wind.direction_deg);
  const headMean = -wind.speed_ms * Math.cos(wdir);   // >0 = vento de proa
  const crossMean = wind.speed_ms * Math.sin(wdir);   // >0 = empurra para +y
  const sg = wind.turbulence * wind.speed_ms;
  const gustU = bandNoise(rng.fork(), 0.15, 1.6), gustW = bandNoise(rng.fork(), 0.3, 2.5);
  const gustV = bandNoise(rng.fork(), 0.15, 1.2);
  const nLat = bandNoise(rng.fork(), 0.08, 0.5), nRoll = bandNoise(rng.fork(), 0.4, 1.8);
  const nYaw = bandNoise(rng.fork(), 0.3, 1.2);

  const vStall = Math.sqrt((2 * W) / (RHO * S * d.cl_max));
  const vR = d.rotate_speed_factor * vStall;
  const alphaRot = deg(d.alpha_rotate_deg);
  const alpha0 = 0; // atitude de corrida
  const qRot = deg(d.pitch_rate_deg_s);
  const hg = ac.gear_height_m, xg = ac.main_gear_x_m;
  const tailStrike = Math.atan2(hg * 0.75, ac.tail_arm_m);

  const dt = 1 / 1000;
  let t = 0, x = 0, V = 0, z = hg, gamma = 0, theta = 0;
  let airborne = false, rotating = false;
  const ev = { v_stall: vStall, v_rotate: vR, mass_kg: mass, t_rotate: null, t_liftoff: null, t_cross: null };
  const out = [];
  let tEnd = Infinity;

  const cl = (alpha) => {
    const c = d.cl_ground + d.cl_alpha_per_rad * (alpha - alpha0);
    if (c <= d.cl_max) return Math.max(c, -0.5);
    return Math.max(d.cl_max - 2.5 * (c - d.cl_max), 0.6 * d.cl_max); // pós-estol suave
  };

  while (t < tEnd && t < 40) {
    const head = headMean + sg * gustU(t);
    const Va = Math.max(V + head, 0);
    const q = 0.5 * RHO * Va * Va * S;
    const alpha = theta - gamma + (airborne ? (sg * gustW(t)) / Math.max(Va, 4) : 0);
    const CL = cl(alpha);
    const CD = d.cd0 + d.induced_k * CL * CL;
    const Lf = q * CL, Df = q * CD;
    const T = Math.max(d.static_thrust_n * (1 - Va / d.thrust_zero_speed_ms), 0);

    // Perturbações laterais (corrida: pequenas; voo: maiores).
    const air = airborne ? smoothstep((t - ev.t_liftoff) / 0.5) : 0;
    const y = d.lateral_offset_m + d.lateral_sigma_m * nLat(t) * (0.4 + 0.6 * smoothstep(x / 20))
      + air * 0.15 * crossMean * (t - (ev.t_liftoff ?? t));
    const roll = deg(d.roll_sigma_deg) * nRoll(t) * (0.15 + 0.85 * air);
    const yaw = deg(d.yaw_sigma_deg) * nYaw(t) * (0.3 + 0.7 * air)
      - air * 0.6 * Math.atan2(crossMean + sg * gustV(t), Math.max(V, 3));

    out.push({ t, x, y, z, roll, pitch: theta, yaw, V, airborne });

    if (!rotating && (d.rotate_at_x_m != null ? x >= d.rotate_at_x_m : Va >= vR)) {
      rotating = true; ev.t_rotate = t;
    }
    if (!airborne) {
      const N = Math.max(W - Lf, 0);
      V += ((T - Df - d.rolling_friction * N) / mass) * dt;
      if (rotating) theta = Math.min(theta + qRot * dt, Math.min(alphaRot, tailStrike));
      x += V * dt;
      z = hg * Math.cos(theta) - xg * Math.sin(theta);
      if (Lf > W && rotating) { airborne = true; ev.t_liftoff = t; }
    } else {
      V += ((T * Math.cos(alpha) - Df) / mass - G * Math.sin(gamma)) * dt;
      gamma += ((Lf + T * Math.sin(alpha) - W * Math.cos(gamma)) / (mass * Math.max(V, 3))) * dt;
      // Piloto: mantém o ângulo de ataque de subida, com taxa de arfagem limitada.
      // Alvo: ângulo de subida `climb_angle_deg`; alfa de equilíbrio (L=W) + correção proporcional.
      const alphaTrim = alpha0 + (W / Math.max(q, 1) - d.cl_ground) / d.cl_alpha_per_rad;
      const alphaCmd = clamp(alphaTrim + 1.5 * (deg(d.climb_angle_deg ?? 6) - gamma), deg(-2), alphaRot);
      const thetaCmd = gamma + alphaCmd;
      theta += clamp(thetaCmd - theta, -qRot * dt, qRot * dt);
      x += V * Math.cos(gamma) * dt;
      z += V * Math.sin(gamma) * dt;
      const zGround = hg * Math.cos(theta) - xg * Math.sin(theta);
      if (z < zGround) { z = zGround; gamma = Math.max(gamma, 0); if (Lf < W) { airborne = false; gamma = 0; } }
    }
    t += dt;
    if (ev.t_cross == null && x >= L) { ev.t_cross = t; tEnd = t + d.extra_time_s; }
  }
  return { dt, samples: out, events: ev };
}

// Folga real: menor (z - altura do obstáculo) entre todos os vértices da aeronave no instante
// em que cada um cruza o plano do obstáculo.
export function clearanceFromPoses(poseAt, t0, t1, verts, xObs, hObs, step = 1 / 2000) {
  const n = verts.length / 3;
  const prevX = new Float64Array(n), prevZ = new Float64Array(n), prevY = new Float64Array(n);
  let best = { clearance: Infinity, vertex: -1, t: null, y: null, crossed: 0 };
  let first = true;
  for (let t = t0; t <= t1; t += step) {
    const m = poseAt(t).matrix; // 4x4 column-major (three.js)
    for (let i = 0; i < n; i++) {
      const bx = verts[3 * i], by = verts[3 * i + 1], bz = verts[3 * i + 2];
      const wx = m[0] * bx + m[4] * by + m[8] * bz + m[12];
      const wy = m[1] * bx + m[5] * by + m[9] * bz + m[13];
      const wz = m[2] * bx + m[6] * by + m[10] * bz + m[14];
      if (!first && prevX[i] < xObs && wx >= xObs) {
        const f = (xObs - prevX[i]) / (wx - prevX[i]);
        const zc = prevZ[i] + f * (wz - prevZ[i]);
        best.crossed++;
        if (zc - hObs < best.clearance) {
          best = { ...best, clearance: zc - hObs, vertex: i, t: t - step + f * step, y: prevY[i] + f * (wy - prevY[i]) };
        }
      }
      prevX[i] = wx; prevZ[i] = wz; prevY[i] = wy;
    }
    first = false;
  }
  return best;
}

export function simulateTakeoff(cfg, clearanceOf) {
  const d = cfg.dynamics;
  let traj = integrate(cfg, d.mass_kg, cfg.seed);
  if (d.target_clearance_m != null && clearanceOf) {
    // Bisseção na massa: mais massa => menos folga.
    let lo = d.mass_kg * 0.35, hi = d.mass_kg * 2.2;
    for (let i = 0; i < 26; i++) {
      const mid = 0.5 * (lo + hi);
      traj = integrate(cfg, mid, cfg.seed);
      const c = traj.events.t_cross == null ? -Infinity : clearanceOf(traj);
      if (c > d.target_clearance_m) lo = mid; else hi = mid;
    }
  }
  return traj;
}
