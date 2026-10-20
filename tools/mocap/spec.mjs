// Which CMU takes become which clips (CMU Graphics Lab Motion Capture Database, mocap.cs.cmu.edu).
export const SPEC = [
  // locomotion cycles (phase 0 = left foot strike)
  { name: 'walk', id: '35_01', kind: 'cycle' },
  { name: 'jog', id: '16_35', kind: 'cycle' },
  { name: 'run', id: '09_06', kind: 'cycle' },
  { name: 'run_fast', id: '127_07', kind: 'cycle' },
  { name: 'sprint', id: '127_08', kind: 'cycle' },
  { name: 'walk_back', id: '136_25', kind: 'cycle', at: 6 },
  // standing idle (looped)
  { name: 'idle', id: '113_21', kind: 'action', t0: 1.0, t1: 9.0, ref: 1.0, fps: 30, loop: 1.0, sigma: 2 },
  // soccer kicks, right foot; ref = boot meets ball (peak toe speed)
  { name: 'kick_shot', id: '11_01', kind: 'action', t0: 2.6, t1: 4.4, ref: 3.37, fps: 60 },
  { name: 'kick_shot2', id: '10_02', kind: 'action', t0: 2.25, t1: 3.95, ref: 2.92, fps: 60 },
  { name: 'kick_pass', id: '10_05', kind: 'action', t0: 1.9, t1: 3.4, ref: 2.52, fps: 60 },
  { name: 'kick_long', id: '10_06', kind: 'action', t0: 2.8, t1: 4.5, ref: 3.40, fps: 60 },
  // jump (headers): ref = apex
  { name: 'jump', id: '118_01', kind: 'action', t0: 2.75, t1: 4.9, ref: 3.8, refMode: 'maxRootY', fps: 60 },
  // fall forward onto the chest, then lying → get up
  { name: 'fall', id: '90_16', kind: 'action', t0: 3.5, t1: 6.0, ref: 3.5, yawAt: 2.6, fps: 60 },
  { name: 'getup', id: '140_01', kind: 'action', t0: 0.4, t1: 5.2, ref: 0.4, yawAxis: true, fps: 30 },
];
