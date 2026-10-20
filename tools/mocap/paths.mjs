// Paths for the offline asset build (see README.md in this folder).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../..');
export const CACHE = path.join(here, '.cache');          // downloads (git-ignored)
export const MH = path.join(CACHE, 'makehuman');          // MPFB2 data subset (CC0)
export const CMU = path.join(CACHE, 'cmu');               // CMU ASF/AMC takes
export const OUT = path.join(ROOT, 'web/public/models');  // what the game loads
