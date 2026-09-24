/* ══════════════════════════════════════════════════════════════════════════
   Ink Landscape — a bamboo gorge with a waterfall, in Three.js

   Shared by the site hero and the standalone page, so the two can never
   drift apart. Pass interactive:true for orbit + zoom (the standalone
   page); the hero leaves it off so the wheel keeps scrolling the document.
   ══════════════════════════════════════════════════════════════════════════ */
import * as THREE from 'three';
import { OrbitControls } from './three/OrbitControls.js';

export function mountInkLandscape({ canvas, interactive = false, panX = 0 }) {
// panX swings the aim sideways without moving the eye, so the falls lands off
// to one side of the frame — room for a column of text that would otherwise
// sit right on top of it.
/* Measure the box the canvas is meant to fill, not the canvas itself, and clamp
   it. If the canvas ever ends up in flow, its own measurement feeds back into
   the layout and the two ratchet each other up without limit. */
const box = canvas.parentElement || canvas;
const sizeOf = () => {
  const r = box.getBoundingClientRect();
  return {
    w: Math.min(Math.max(1, Math.round(r.width)), 4096),
    h: Math.min(Math.max(1, Math.round(r.height)), 4096),
  };
};
let { w: VW, h: VH } = sizeOf();

/* ══════════════════════════════════════════════════════════════
   Palette
   ══════════════════════════════════════════════════════════════ */
const PAPER = new THREE.Color('#eef2f2');   // the page colour the hero has to meet

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
// Phones and small machines get the same scene with a lighter hand: fewer noise
// octaves, a smaller shadow map, native-ish pixel density.
const lowPower = matchMedia('(max-width: 720px)').matches
              || (navigator.hardwareConcurrency || 8) <= 4;

/* ── renderer ─────────────────────────────────────────────────
   Linear lighting, filmic tone mapping, sRGB out. Every custom shader ends in
   the tonemapping + colorspace chunks so it goes through the same curve as the
   sky; before this the shaders wrote linear values straight to the screen and
   the whole scene sat darker than its own fog colour. */
const renderer = new THREE.WebGLRenderer({ antialias: true, canvas });
renderer.setPixelRatio(Math.min(devicePixelRatio, lowPower ? 1.25 : 1.5));
renderer.setSize(VW, VH, false);   // false: never write inline CSS size onto the canvas
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.6;   // three's ACES divides by 0.6: this is neutral
renderer.setClearColor(PAPER, 1);
// The sun never moves and the only thing that does — bamboo swaying — is too
// slight to show in a shadow, so the shadow map is drawn exactly once.
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;
renderer.shadowMap.needsUpdate = true;

/* The sky is brighter than paper white on purpose: the film curve pulls it
   back down, and it has to land on the page's own colour for the hero to melt
   into the page. Fog uses the same value so distance dissolves into the sky
   rather than into a band slightly darker than it. */
const SKY_GAIN = 3.4;
const SKY = PAPER.clone().multiplyScalar(SKY_GAIN);

const scene  = new THREE.Scene();
scene.fog    = new THREE.FogExp2(SKY, 0.0036);

/* ── one light for everything ─────────────────────────────────
   A soft, high sun from the right, and a strong overcast sky: a misty gorge is
   lit mostly by the sky, with the sun only raking the rock enough to show it. */
const SUN_DIR = new THREE.Vector3(0.55, 0.62, 0.35).normalize();
const LIGHTING = {
  sunDir:    { value: SUN_DIR },
  sunColor:  { value: new THREE.Color(1.00, 0.95, 0.88).multiplyScalar(2.1) },
  skyAmb:    { value: new THREE.Color(0.74, 0.81, 0.86) },
  groundAmb: { value: new THREE.Color(0.30, 0.31, 0.28) },
};
const LIGHT_GLSL = /* glsl */`
  uniform vec3 sunDir, sunColor, skyAmb, groundAmb;
  // Lambert from the sun, hemisphere ambient from sky and ground. AO darkens
  // only the ambient: occlusion is about sky you cannot see, not the sun.
  vec3 shadeLit(vec3 albedo, vec3 N, float shadow, float ao) {
    float ndl = max(dot(N, sunDir), 0.0);
    vec3 amb  = mix(groundAmb, skyAmb, N.y * 0.5 + 0.5);
    return albedo * (sunColor * ndl * shadow + amb * ao);
  }`;

/* Procedural 3D value noise. Solid noise needs no UV layout and no triplanar
   blending — it is defined everywhere in space, so a cliff face and a ledge
   top read from the same rock. OCTAVES is a compile-time define so phones can
   run fewer. */
const NOISE_GLSL = /* glsl */`
  #ifndef OCTAVES
  #define OCTAVES 5
  #endif
  float hash3(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float noise3(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash3(i + vec3(0,0,0)), hash3(i + vec3(1,0,0)), f.x),
                   mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), f.x),
                   mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm3(vec3 p) {
    float a = 0.5, s = 0.0;
    for (int i = 0; i < OCTAVES; i++) {
      s += a * noise3(p);
      p = p * 2.03 + vec3(1.7, 9.2, 3.1);
      a *= 0.5;
    }
    return s;
  }
  // Bump a normal by a scalar height field using screen-space derivatives —
  // relief with no extra geometry and no tangent frame.
  vec3 perturbNormal(vec3 pos, vec3 N, float h, float strength) {
    vec3 dpdx = dFdx(pos), dpdy = dFdy(pos);
    float dhdx = dFdx(h), dhdy = dFdy(h);
    vec3 r1 = cross(dpdy, N), r2 = cross(N, dpdx);
    float det = dot(dpdx, r1);
    vec3 grad = sign(det) * (dhdx * r1 + dhdy * r2);
    return normalize(abs(det) * N - strength * grad);
  }`;

// Materials that receive the sun's shadow need three's light uniforms merged in;
// the shared lighting uniforms are then attached by reference.
const litUniforms = extra => {
  const u = THREE.UniformsUtils.merge([THREE.UniformsLib.lights, THREE.UniformsLib.fog, extra]);
  return Object.assign(u, LIGHTING);
};
const SHADOW_PARS_FRAG = /* glsl */`
  #include <packing>
  #include <bsdfs>
  #include <lights_pars_begin>
  #include <shadowmap_pars_fragment>
  #include <shadowmask_pars_fragment>`;
const DEFINES = { OCTAVES: lowPower ? 3 : 5 };

const camera = new THREE.PerspectiveCamera(40, VW / VH, 0.1, 700);
camera.position.set(0, 5.2, 34);

/* ── noise: value fbm + ridged multifractal ─────────────────── */
const hash = (x, y) => { const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123; return n - Math.floor(n); };
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}
function ridged(x, y, oct = 5) {
  let sum = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    let n = vnoise(x * f, y * f) * 2 - 1;
    n = 1 - Math.abs(n); n *= n;
    sum += n * amp; norm += amp;
    amp *= 0.5; f *= 2.03;
  }
  return sum / norm;
}
const sstep = (e0, e1, x) => { const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1); return t * t * (3 - 2 * t); };

/* the river meanders — terrain is carved around this centreline */
const riverX = z => Math.sin(z * 0.015) * 4.5 + Math.sin(z * 0.0055) * 3.0;

/* The valley floor sits one step higher upstream, so the stream has to fall
   to reach the viewer. Terrain and water both ride this same curve. */
/* A short z-span makes the bed a cliff rather than a ramp; the falling sheet
   itself is a dedicated mesh hung in front of it. */
const FALL_TOP = -56, FALL_BOT = -50, FALL_H = 24;
const bedAt = z => FALL_H * (1 - sstep(FALL_TOP, FALL_BOT, z));

const LIP_CX = riverX(FALL_TOP - 0.5);

function terrainHeight(x, z) {
  // A fall excavates a basin wider than itself, and that basin sits under the
  // lip — not on the meander line, which has already wandered off by the time
  // the water lands. Without this the channel pinched in from one side and the
  // pool came out narrower than the curtain feeding it.
  // Monotone on each side of the foot. A symmetric bump here widened the
  // channel and then closed it again while the centreline was still sliding
  // back to the meander, which folded the bank into a hook.
  // Monotone on each side of the foot, and slow to let go: the basin has to
  // ease into the ordinary channel over most of the reach, or the bank closes
  // in on the eye like a funnel. A symmetric bump also folded it into a hook,
  // widening and re-closing while the centreline was still sliding back.
  const ds = z - FALL_BOT;                          // >0 is downstream
  const basin = ds < 0 ? sstep(-12, 0, ds) : 1 - sstep(0, 90, ds);
  const cx = riverX(z) + (LIP_CX - riverX(z)) * basin;
  const d = Math.abs(x - cx);
  const inner = 8 + 6 * basin;
  const valley = sstep(inner, inner + 18, d);       // 0 in the water, 1 in the hills
  // near banks still need real relief, or the stream spreads out into a lake
  const far    = 0.85 + 1.45 * sstep(10, -190, z); // ranges grow with distance
  let h = ridged(x * 0.0115, z * 0.0115, 5);
  h = Math.pow(h, 1.45) * 30 * valley * far;
  h += ridged(x * 0.055, z * 0.055, 3) * 1.1 * valley; // bank roughness
  // A deterministic shoulder as well as the noise. Relying on noise alone
  // leaves dips that fall under the waterline far from the channel, so the
  // wet width becomes ragged and unmeasurable — and the curtain cannot be
  // matched to a width that is not well defined.
  h += valley * 3.2 * far;
  return bedAt(z) + h;
}

/* ══════════════════════════════════════════════════════════════
   TERRAIN — displaced geometry, lit rock and ground
   ══════════════════════════════════════════════════════════════ */
const TW = 420, TD = 460, SEG = 300;
const CELL_X = TW / SEG, CELL_Y = TD / SEG;
const tGeo = new THREE.PlaneGeometry(TW, TD, SEG, SEG);
{
  const p = tGeo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    // plane lies in XY and is displaced along +Z; after the -90° X rotation
    // world z is -y, so the field must be sampled there and nowhere else —
    // any offset here and the carved channel drifts off the actual river
    const x = p.getX(i), y = p.getY(i);
    p.setZ(i, terrainHeight(x, -y));
  }
  tGeo.computeVertexNormals();
}

/* Ambient occlusion, baked once from the height grid: for each vertex, how
   much sky the surrounding terrain hides (horizon angle in eight directions).
   The gorge floor and the foot of every cliff darken; ridges stay open. This
   is what grounds things — without it nothing touches anything. Reads from the
   grid rather than re-sampling the noise, so it costs a few milliseconds. */
const terrainAO = (() => {
  const p = tGeo.attributes.position, W1 = SEG + 1;
  const H = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) H[i] = p.getZ(i);
  const ao = new Float32Array(p.count);
  const DIRS = 8, RADII = [1.5, 3.5, 7, 13, 24];
  const dirs = [];
  for (let k = 0; k < DIRS; k++) {
    const a = (k / DIRS) * Math.PI * 2;
    dirs.push([Math.cos(a), Math.sin(a)]);
  }
  for (let iy = 0; iy <= SEG; iy++) {
    for (let ix = 0; ix <= SEG; ix++) {
      const i = iy * W1 + ix, h0 = H[i];
      let occ = 0;
      for (const [dx, dy] of dirs) {
        let best = 0;
        for (const r of RADII) {
          const sx = Math.round(ix + (dx * r) / CELL_X);
          const sy = Math.round(iy + (dy * r) / CELL_Y);
          if (sx < 0 || sy < 0 || sx > SEG || sy > SEG) break;
          const tan = (H[sy * W1 + sx] - h0) / r;
          if (tan > best) best = tan;
        }
        occ += best / Math.sqrt(1 + best * best);   // sine of the horizon angle
      }
      ao[i] = 1 - occ / DIRS;
    }
  }
  return ao;
})();
tGeo.setAttribute('aAO', new THREE.BufferAttribute(terrainAO, 1));

const terrain = new THREE.Mesh(tGeo, new THREE.ShaderMaterial({
  fog: true, lights: true, defines: DEFINES,
  uniforms: litUniforms({
    fallTop: { value: FALL_TOP },
    fallBot: { value: FALL_BOT },
    fallH:   { value: FALL_H },
  }),
  vertexShader: /* glsl */`
    #include <common>
    #include <shadowmap_pars_vertex>
    #include <fog_pars_vertex>
    attribute float aAO;
    varying float vAO;
    varying vec3  vWorld, vWN;
    void main() {
      vAO = aAO;
      #include <beginnormal_vertex>
      #include <defaultnormal_vertex>
      #include <begin_vertex>
      #include <project_vertex>
      #include <worldpos_vertex>
      #include <shadowmap_vertex>
      #include <fog_vertex>
      vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
      vWN    = normalize(mat3(modelMatrix) * normal);
    }`,
  fragmentShader: /* glsl */`
    #include <common>
    #include <fog_pars_fragment>
    ${SHADOW_PARS_FRAG}
    ${LIGHT_GLSL}
    ${NOISE_GLSL}
    uniform float fallTop, fallBot, fallH;
    varying float vAO;
    varying vec3  vWorld, vWN;

    void main() {
      vec3  p     = vWorld;
      vec3  Ng    = normalize(vWN);
      float steep = 1.0 - clamp(Ng.y, 0.0, 1.0);          // 0 flat, 1 sheer
      float range = length(cameraPosition - p);
      // micro-relief fades with distance: past this it only aliases, and the
      // fog is carrying the far ranges anyway
      float detail = 1.0 - smoothstep(70.0, 230.0, range);

      // height above the local waterline — the bed steps up above the falls
      float bed   = fallH * (1.0 - smoothstep(fallTop, fallBot, p.z));
      float above = p.y - (bed + 0.28);

      // ROCK. Thick bedding planes, strongly warped so no two read as parallel
      // rules, broken into ledges of uneven height; sparse vertical joints; a
      // fine grain over everything. Evenly spaced layers read as masonry.
      float n1      = fbm3(p * 0.21);
      float warp    = fbm3(p * 0.045);
      float stratum = p.y * 0.17 + warp * 3.4 + fbm3(p * vec3(0.02, 0.0, 0.02)) * 2.0;
      float bandW   = 0.18 + 0.30 * noise3(p * 0.07);            // ledge edges vary
      float ledge   = smoothstep(0.0, bandW, abs(fract(stratum) - 0.5) * 2.0);
      // Bedding only shows on near-vertical faces. On a moderate slope the same
      // horizontal planes cut shallowly and spread into contour-map bands.
      ledge = mix(0.6, ledge, smoothstep(0.42, 0.78, steep));
      // joints stretched along y so they run down the face, not round it
      float joint   = 1.0 - abs(noise3(p * vec3(0.22, 0.035, 0.22)) * 2.0 - 1.0);
      float crack   = smoothstep(0.955, 0.995, joint) * smoothstep(0.35, 0.65, noise3(p * 0.05));
      float grain   = detail > 0.0 ? fbm3(p * 1.35) : 0.5;
      float rockH   = ledge * 0.50 + grain * 0.50 - crack * 0.7;

      // Rock relief only where there is rock. On gentle ground the same field
      // drew contour-like squiggles; there it gets an isotropic grain instead.
      float rockMask = smoothstep(0.26, 0.60, steep);
      float bumpH    = mix(grain, rockH, rockMask);
      vec3  N = perturbNormal(p, Ng, bumpH, mix(0.12, 1.0, rockMask) * detail);

      // albedo, in linear light
      vec3 rockCol = mix(vec3(0.090, 0.095, 0.098), vec3(0.185, 0.188, 0.186), n1);
      rockCol *= (0.86 + 0.24 * ledge) * (1.0 - 0.35 * crack);
      vec3 mossCol = vec3(0.055, 0.075, 0.046) * (0.78 + 0.44 * n1);
      vec3 soilCol = vec3(0.135, 0.135, 0.118) * (0.84 + 0.32 * grain);

      // moss likes low, damp, gentle ground — and the tops of ledges
      float damp = 1.0 - smoothstep(0.0, 16.0, above);
      float moss = (1.0 - smoothstep(0.12, 0.55, steep)) * (0.42 + 0.58 * damp);
      moss = max(moss, rockMask * smoothstep(0.62, 0.95, N.y) * 0.65);
      vec3 albedo = mix(soilCol, mossCol, clamp(moss, 0.0, 1.0));
      albedo = mix(albedo, rockCol, rockMask);
      // stone darkens where the water keeps it wet
      albedo *= mix(0.52, 1.0, smoothstep(0.0, 1.8, above));

      vec3 col = shadeLit(albedo, N, getShadowMask(), vAO);
      gl_FragColor = vec4(col, 1.0);
      #include <fog_fragment>
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
}));
terrain.rotation.x = -Math.PI / 2;
terrain.receiveShadow = true;
terrain.castShadow = true;
scene.add(terrain);

/* ── the sun, as far as three is concerned ─────────────────────
   Only here to drive the shadow map; the shaders do their own lighting from
   SUN_DIR. Its orthographic shadow camera is framed on the gorge — the far
   ranges are in fog and don't need shadow resolution spent on them. */
const sun = new THREE.DirectionalLight(0xffffff, 1);
sun.target.position.set(LIP_CX, 0, FALL_BOT - 10);
sun.position.copy(sun.target.position).addScaledVector(SUN_DIR, 220);
sun.castShadow = true;
sun.shadow.mapSize.set(lowPower ? 1024 : 2048, lowPower ? 1024 : 2048);
Object.assign(sun.shadow.camera, { left: -125, right: 125, top: 125, bottom: -125, near: 10, far: 480 });
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.5;
sun.shadow.radius = 3;
scene.add(sun, sun.target);

/* ── sky ───────────────────────────────────────────────────────
   A dome that follows the eye, so the sky goes through the same film curve as
   everything under it. The horizon is exactly the fog colour; overhead it cools
   and deepens slightly, and brightens toward the sun. */
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(640, 32, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { horizon: { value: SKY }, sunDir: { value: SUN_DIR } },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 horizon, sunDir;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        vec3 zenith = horizon * vec3(0.86, 0.91, 0.97);
        vec3 col = mix(horizon, zenith, smoothstep(0.02, 0.65, d.y));
        col *= 1.0 + 0.10 * pow(max(dot(d, sunDir), 0.0), 6.0);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  })
);
sky.renderOrder = -1;
scene.add(sky);

/* ══════════════════════════════════════════════════════════════
   WATER — rippling plane, sky-pale at grazing angles
   ══════════════════════════════════════════════════════════════ */
const water = new THREE.Mesh(
  // dense along its length so the lip of the falls stays a crisp edge
  new THREE.PlaneGeometry(300, 460, 200, 460),
  new THREE.ShaderMaterial({
    fog: true, transparent: true, lights: true,
    uniforms: litUniforms({
      uTime:   { value: 0 },
      // a gorge pool is dark: nearly all of its brightness is reflected sky
      water:   { value: new THREE.Color(0.030, 0.048, 0.052) },
      paper:   { value: SKY },
      fallTop: { value: FALL_TOP },
      fallBot: { value: FALL_BOT },
      fallH:   { value: FALL_H },
      fallCx:  { value: 0 },          // set once the channel has been measured
      fallHalfW: { value: 10 },       // likewise
      wallCol: { value: new THREE.Color(0.19, 0.20, 0.19) },  // lit gorge rock, roughly
    }),
    vertexShader: /* glsl */`
      #include <common>
      #include <shadowmap_pars_vertex>
      #include <fog_pars_vertex>
      uniform float uTime;
      uniform float fallTop, fallBot, fallH;
      varying vec3  vWorld;
      varying float vFall;     // 0 on flat water, 1 in the throat of the falls
      void main() {
        vec3 pos = position;

        // after the mesh rotation world z is -y, so the bed is sampled there
        float wz = -pos.y;
        float s  = smoothstep(fallTop, fallBot, wz);
        pos.z += fallH * (1.0 - s);
        vFall  = 1.0 - abs(s * 2.0 - 1.0);

        // only the long, slow swell is real geometry — the fine grain of the
        // surface is drawn per pixel, where it can never be under-sampled
        pos.z += sin(pos.x * 0.16 + uTime * 0.45) * 0.055
               + sin(pos.y * 0.11 - uTime * 0.33) * 0.045;

        vec4 worldPosition     = modelMatrix * vec4(pos, 1.0);
        vec3 transformedNormal = normalMatrix * vec3(0.0, 0.0, 1.0);
        vWorld = worldPosition.xyz;
        vec4 mvPosition = viewMatrix * worldPosition;
        gl_Position = projectionMatrix * mvPosition;
        #include <shadowmap_vertex>
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */`
      #include <common>
      #include <fog_pars_fragment>
      ${SHADOW_PARS_FRAG}
      ${LIGHT_GLSL}
      uniform vec3 water, paper, wallCol;
      uniform float uTime, fallBot, fallCx, fallHalfW, fallH;
      varying vec3  vWorld;
      varying float vFall;

      // Structure runs ALONG the current: strong variation across the stream,
      // only a slow waver down it. That yields lengthwise threads rather than
      // ranks marching at the viewer, which always read as horizontal bands.
      float ripple(vec2 p, float t) {
        float r = 0.0;
        r += sin(p.x * 0.62 + p.y * 0.06 - t * 0.85) * 1.00;
        r += sin(p.x * 1.13 - p.y * 0.04 + t * 0.66) * 0.54;
        r += sin(p.x * 0.31 + p.y * 0.09 - t * 0.52) * 0.42;
        r += sin(p.x * 2.05 + p.y * 0.12 - t * 1.15) * 0.24;
        r += sin(p.x * 3.60 - p.y * 0.08 + t * 1.55) * 0.11;
        return r;
      }

      // One stroke per period of v, half-width w. Antialiased by its own
      // screen gradient, and faded out entirely once a pixel spans more than
      // the stroke itself — otherwise a grazing surface turns solid white.
      float stroke(float v, float w) {
        float g  = abs(fract(v) - 0.5);
        float aa = clamp(fwidth(v) * 0.5, 0.0004, 0.30);
        // edges MUST stay ordered — handing smoothstep e0 > e1 turns the line
        // into a full-period ramp, which floods the surface instead of drawing on it
        float m  = 1.0 - smoothstep(max(w - aa, 0.0), w + aa, g);
        return m * (1.0 - smoothstep(w * 1.5, w * 5.0, aa));
      }

      void main() {
        // The cliff face belongs to the falls mesh and to bare rock — drop the
        // river's own near-vertical sheet, which would otherwise paint a pale
        // wall over both.
        // Cut the whole ramp, not just its middle: a tilted strip left at the
        // lip or the foot catches the light and reads as a hard white bar.
        if (vFall > 0.015) discard;

        vec2 p = vWorld.xz;
        float t = uTime;

        // The surface is shaded by its own slope rather than drawn as contour
        // lines: contours of a downstream-ranked field are by definition
        // horizontal bands, and no amount of tuning makes stripes look like water.
        float r  = ripple(p, t);
        float dx = ripple(p + vec2(0.85, 0.0), t) - r;
        float dz = ripple(p + vec2(0.0, 0.85), t) - r;
        vec3  n  = normalize(vec3(-dx, 5.0, -dz));

        // Fresnel (Schlick) in world space, against the rippled normal. The old
        // version took .y of a view-space vector, which is not the angle to the
        // water at all — it only looked plausible from one camera height.
        vec3  V    = normalize(cameraPosition - vWorld);
        float cosT = clamp(dot(n, V), 0.0, 1.0);
        float F    = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);

        // body colour is lit, and takes the cliff's shadow
        vec3 body = shadeLit(water, vec3(0.0, 1.0, 0.0), getShadowMask(), 1.0);

        // What the reflection actually sees. In a gorge a low reflected ray hits
        // the walls, not the sky — reflecting open sky everywhere turned the whole
        // river white. So: follow the reflected ray to the plane of the falls; if
        // it lands on the curtain, the pool mirrors the falls; otherwise it sees
        // wall until it rises high enough to clear the rim, then sky.
        vec3  R   = reflect(-V, n);
        float env = smoothstep(0.16, 0.55, R.y);
        vec3  refl = mix(wallCol, paper * 0.94, env);
        if (R.z < -0.01) {
          float tHit = (-52.0 - vWorld.z) / R.z;          // the curtain's mid-depth
          vec3  hit  = vWorld + R * tHit;
          float onFalls = step(0.0, tHit)
                        * (1.0 - smoothstep(fallHalfW * 0.85, fallHalfW * 1.02, abs(hit.x - fallCx)))
                        * step(0.0, hit.y) * (1.0 - smoothstep(fallH * 0.92, fallH, hit.y));
          refl = mix(refl, paper * 0.80, onFalls);
        }
        vec3 col  = mix(body, refl, F);
        vec3 foamCol    = paper * 0.52;            // white water, a shade under the sky
        vec3 shallowCol = mix(body, vec3(0.16, 0.16, 0.14), 0.55);  // thin water over the bed

        // a sun glint on facets that tip toward it
        vec3  Hh   = normalize(sunDir + V);
        col += sunColor * pow(max(dot(n, Hh), 0.0), 180.0) * 0.35 * getShadowMask();

        // Foam leaves the plunge and is carried downstream — a wake, not a halo,
        // so it must be one-sided about the basin and drawn out along the flow.
        float ds = p.y - fallBot;                       // >0 is downstream
        float wake = smoothstep(-3.0, 1.5, ds) * (1.0 - smoothstep(2.0, 22.0, ds));
        // torn into streamers by the same lengthwise field as the rest of the river
        wake *= 0.55 + 0.45 * (0.5 + 0.5 * sin(p.x * 1.6 + r * 1.2));
        col = mix(col, foamCol, wake * 0.30);

        // The churn where the column actually strikes. Without it the pool
        // simply begins along a straight line in z and the seam is obvious.
        vec2 q = vec2((p.x - fallCx) / 11.0, (p.y - fallBot - 3.0) / 8.0);
        float churn = exp(-dot(q, q) * 1.5);
        churn *= 0.52 + 0.48 * (0.5 + 0.5 * sin(p.x * 2.3 + p.y * 1.9 + t * 2.4))
                      * (0.5 + 0.5 * sin(p.x * 5.1 - p.y * 3.3 - t * 3.1));
        col = mix(col, foamCol, clamp(churn, 0.0, 1.0) * 0.55);

        // Shallows. The same channel the terrain is carved from, so the water
        // pales exactly where it runs thin over the bank instead of meeting it
        // as a flat cut. This is what stops the reach reading as a slab.
        float rx  = sin(p.y * 0.015) * 4.5 + sin(p.y * 0.0055) * 3.0;
        float bas = ds < 0.0 ? smoothstep(-12.0, 0.0, ds)
                             : 1.0 - smoothstep(0.0, 90.0, ds);
        float cxr = mix(rx, fallCx, bas);
        float dw  = abs(p.x - cxr);
        float hw  = 8.0 + 6.0 * bas + 3.5;        // where the wet edge falls
        float shallow = smoothstep(hw - 8.0, hw, dw);
        col = mix(col, shallowCol, shallow * 0.62);

        // and a thread of light where the current parts around the margin
        col = mix(col, foamCol,
                  smoothstep(0.55, 0.95, shallow) * (1.0 - smoothstep(0.95, 1.0, shallow))
                  * (0.45 + 0.55 * (0.5 + 0.5 * sin(p.y * 0.7 + r * 2.0))) * 0.30);

        // the pool's upstream edge fades over its last metre rather than
        // stopping on a straight line under the falls
        gl_FragColor = vec4(col, 0.94 * (1.0 - smoothstep(0.002, 0.015, vFall)));
        #include <fog_fragment>
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  })
);
water.rotation.x = -Math.PI / 2;
water.position.y = 0.28;
scene.add(water);

/* ══════════════════════════════════════════════════════════════
   THE FALLS — vertical curtains over the cliff face
   A long exposure is what makes a waterfall look like silk: the strands
   stay perfectly vertical and smooth, so nearly all the variation lives
   across the sheet, almost none along it.
   ══════════════════════════════════════════════════════════════ */
/* Measure how wide the river actually is where it goes over, rather than
   guessing: a curtain narrower than its own channel leaves the upstream water
   spilling into thin air on both sides. */
function channelHalfWidth(z, dir) {
  const cx = riverX(z), level = bedAt(z) + 0.28;
  let last = 0.25;
  for (let d = 0.25; d < 45; d += 0.25) {
    if (terrainHeight(cx + dir * d, z) <= level) last = d;   // still wet
    else if (d > last + 3) break;                            // truly out of the channel
  }
  return last;
}
/* The bank height wanders, so the wet width does too. One ray at one z
   under-measures it and leaves the upper river spilling past the curtain;
   take the widest the channel gets as it approaches the edge. */
let lipL = 0, lipR = 0;
for (let z = FALL_TOP - 7; z <= FALL_TOP + 0.5; z += 0.5) {
  lipL = Math.max(lipL, channelHalfWidth(z, -1));
  lipR = Math.max(lipR, channelHalfWidth(z,  1));
}
const FALL_W = (lipL + lipR) * 1.04;
const FALL_CX = riverX(FALL_TOP - 0.5) + (lipR - lipL) / 2;
const fallMid = (FALL_TOP + FALL_BOT) / 2;

/* Water leaving a lip is a projectile: it carries the river's horizontal speed
   over the edge and only then falls, so the curtain is a parabola bulging
   downstream — not a plane. A flat billboard collapses to a line the moment
   you look at it from the side, which is exactly what a real fall does not do.
   Built as layered curved sheets so it keeps its body from any angle. */
const LIP_Z  = FALL_TOP + 0.3;
const POOL_Z = FALL_BOT + 0.6;
const THROW  = POOL_Z - LIP_Z;
const T_MIN = -0.34, T_MAX = 1.15;          // runs past lip and pool for continuity
const U_LIP  = (T_MAX - 0) / (T_MAX - T_MIN);
const U_POOL = (T_MAX - 1) / (T_MAX - T_MIN);
const POOL_Y = 0.28;

/* Closed shell, not stacked sheets. A waterfall has a cross-section — a wide
   flattened ellipse — and parallel planes betray themselves as separate layers
   the moment you view them edge-on. Sweeping that section along the parabola
   gives one body of water from every angle, and the loop naturally reads denser
   at the curtain's edges, where the surface turns away from the eye. */
function fallsGeometry(nu, nv) {
  const pos = [], uv = [], idx = [];
  for (let j = 0; j <= nv; j++) {
    const t  = T_MIN + (T_MAX - T_MIN) * j / nv;
    // Upstream of the lip the water is still running level — only past the
    // edge does gravity get hold of it. Carrying the parabola back through
    // t < 0 would sink the river before it ever reached the drop. Both ends
    // sit at the actual water surface, which is 0.28 above each bed level.
    const y  = t <= 0 ? FALL_H + 0.28
                      : FALL_H + 0.28 - (FALL_H) * t * t;
    const zc = LIP_Z + THROW * t;                    // throw goes as t
    const w  = FALL_W * (1 + 0.16 * Math.max(t, 0));
    // flat as a river approaching the edge, swelling as it aerates on the way down
    const th = t <= 0 ? 0.42 : 0.42 + 2.3 * t;
    for (let i = 0; i <= nu; i++) {
      const a  = (i / nu) * Math.PI * 2;
      const lx = Math.cos(a) * w * 0.5;
      let   pz = zc + Math.sin(a) * th;

      // The back of the sheet would otherwise sink into the cliff partway down
      // and be clipped by it, leaving a layer that stops in mid-air. Real water
      // hugs the rock instead: slide any buried vertex downstream until it
      // clears, so the back face lies against the face of the cliff.
      let pushed = false;
      for (let k = 0; k < 60 && terrainHeight(FALL_CX + lx, pz) > y - 0.1; k++) {
        pz += 0.2; pushed = true;
      }
      // and then stand a little proud of it: lying exactly on the rock, the two
      // surfaces fought over depth and the loser showed through in blotches
      if (pushed) pz += 0.45;

      pos.push(lx, y, pz);
      uv.push((Math.cos(a) + 1) * 0.5, (T_MAX - t) / (T_MAX - T_MIN));
    }
  }
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const falls = new THREE.Mesh(
  fallsGeometry(52, 64),
  new THREE.ShaderMaterial({
    fog: true, transparent: true, depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uTime:      { value: 0 },
      paper:      { value: SKY },
      uPool:      { value: U_POOL },
      uLip:       { value: U_LIP },
      uPhase:     { value: 0 },
      uDim:       { value: 1 },
      fogColor:   { value: scene.fog.color },
      fogDensity: { value: scene.fog.density },
    },
    vertexShader: /* glsl */`
      #include <common>
      #include <fog_pars_vertex>
      varying vec2 vUv;
      varying vec3 vN, vV;
      void main() {
        vUv = uv;
        vN = normalize(normalMatrix * normal);
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vV = -mvPosition.xyz;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */`
      #include <common>
      #include <fog_pars_fragment>
      ${NOISE_GLSL}
      uniform float uTime, uPool, uLip, uPhase, uDim;
      uniform vec3  paper;
      varying vec2  vUv;
      varying vec3  vN, vV;

      // one vertical strand — edges kept tight so dark rock shows between falls
      float ribbon(float x, float c, float w) {
        // edges ordered low→high; reversed edges are undefined in GLSL and only
        // happen to work on desktop drivers
        return 1.0 - smoothstep(w * 0.62, w, abs(x - c));
      }

      void main() {
        float x = vUv.x + uPhase * 0.013;
        float t = uTime;

        // 0 at the pool surface, 1 at the lip; runs past both so the sheet
        // joins the upper river and the basin instead of ending at a seam
        float y = (vUv.y - uPool) / (uLip - uPool);

        float xc = x;

        // The strands must span the whole sheet. Clustering them near the
        // middle left the painted water far narrower than the channel feeding
        // it — the geometry was the right width all along, but only the middle
        // of it was ever water.
        float m = 0.0;
        m = max(m, ribbon(xc, 0.500, 0.300));
        m = max(m, ribbon(xc, 0.215, 0.150));
        m = max(m, ribbon(xc, 0.790, 0.140));
        m = max(m, ribbon(xc, 0.070, 0.075));
        m = max(m, ribbon(xc, 0.930, 0.070));

        // Fine threads varying ONLY across the sheet, so the strands stay dead
        // vertical — any y term here bands the silk. Motion is sideways drift.
        float d1 = x + sin(t * 0.23) * 0.004;
        float d2 = x + sin(t * 0.17 + 2.1) * 0.006;
        m *= 0.66
           + 0.15 * (sin(d1 * 211.0) * 0.5 + 0.5)
           + 0.11 * (sin(d2 * 97.0 + 1.7) * 0.5 + 0.5)
           + 0.08 * (sin(d1 * 47.0 + 0.6) * 0.5 + 0.5);

        // FREE FALL. Water leaves the lip at rest and accelerates, so distance
        // goes as time squared — meaning a packet's "age" is sqrt(drop). Riding
        // features at a constant rate in that age makes them speed up as they
        // descend, which is what selling a fall depends on.
        float age = sqrt(clamp(1.0 - y, 0.0, 1.6));

        // Each filament is offset in age, so packets never line up across the
        // sheet — coherent packets would be exactly the horizontal banding we
        // spent this whole scene removing.
        // The stagger must vary as fast as the filaments themselves; a slow
        // sweep across x just tilts the packet fronts and weaves a chevron.
        // Spanning several full turns is the point: offsets smaller than 2π
        // leave neighbouring filaments correlated, and their packet fronts
        // weave into a herringbone instead of falling as separate threads.
        float stagger = (sin(x * 311.0) * 1.70
                       + sin(x * 137.0 + 1.1) * 1.15
                       + sin(x *  57.0 + 2.3) * 0.60) * 4.3 + uPhase * 2.0;

        float ph1 = (age * 7.0 - t * 3.10) * 6.2831 + stagger;
        float ph2 = (age * 12.5 - t * 4.35) * 6.2831 + stagger * 1.7;
        float packets = pow(0.5 + 0.5 * sin(ph1), 3.0) * 0.65
                      + pow(0.5 + 0.5 * sin(ph2), 5.0) * 0.35;

        // they brighten as they gather speed toward the basin
        m *= 0.80 + packets * (0.30 + 0.42 * (1.0 - clamp(y, 0.0, 1.0)));

        // SILVER. A sparse few filaments catch the light and flare — picked at a
        // frequency finer than the threads themselves, and slowly breathing, so
        // it glitters rather than striping. Confined to where there is water.
        float pick   = pow(0.5 + 0.5 * sin(x * 437.0 + 1.7), 14.0);
        float breath = 0.40 + 0.60 * (0.5 + 0.5 * sin(t * 1.9 + x * 63.0));
        float glint  = pow(0.5 + 0.5 * sin(ph1 * 0.5 + stagger * 0.6), 16.0);
        float silver = clamp(pick * breath * 0.9 + glint * 0.45, 0.0, 1.0)
                     * smoothstep(0.02, 0.16, m)
                     * (1.0 - smoothstep(0.92, 1.12, y));      // not on the flat upstream run

        // Upstream the sheet dissolves into the river's own surface, so the two
        // hand over rather than butting together at a visible seam.
        m *= (1.0 - smoothstep(1.03, 1.42, y));
        // Nothing of the sheet survives below the surface: its sub-surface part
        // was laying a flat ghost rectangle across the pool.
        if (y < -0.12) discard;
        // strands dissolve on the way in, but only over the last stretch — a
        // longer fade left the curtain see-through at its foot
        m *= smoothstep(-0.02, 0.12, y);

        // The loop turns tangent to the eye at the curtain's edges, piling many
        // fragments into one pixel; feather them wide or they stack into a flap.
        m *= smoothstep(0.005, 0.055, x) * (1.0 - smoothstep(0.945, 0.995, x));

        // Where it lands: a soft band of foam gathered at the waterline itself,
        // widest where the sheet is heaviest. The pool carries the rest.
        // The plunge: dense spray over the foot, so the base of the fall is
        // white water rather than a veil with rock showing through. Kept low and
        // billowing — a wide even band read as a white wall.
        float band = exp(-pow((y - 0.03) / 0.13, 2.0));
        float boil = noise3(vec3(x * 16.0, y * 7.0 - t * 0.9, t * 0.35)) * 0.6
                   + noise3(vec3(x * 41.0, y * 15.0 - t * 1.6, t * 0.5)) * 0.4;
        float foam = band * smoothstep(0.28, 0.72, boil + 0.25 * band)
                   * smoothstep(0.02, 0.14, x) * (1.0 - smoothstep(0.86, 0.98, x));

        // Where the shell turns edge-on, front and back pile into the same
        // pixels and stack into a hard bright rib. Fade by facing ratio.
        float facing = abs(dot(normalize(vN), normalize(vV)));

        float a = (clamp(m, 0.0, 1.0) * 0.90 + foam * 0.75 + silver * 0.34)
                * uDim * smoothstep(0.05, 0.40, facing);
        if (a < 0.004) discard;

        // White water is brighter than the overcast sky behind it; working in
        // multiples of the sky keeps it the brightest thing in the valley once
        // the film curve has rolled the highlights off.
        // Strands live in the upper midtones so the film curve keeps their
        // texture; only the spray is pushed into full white. When the whole
        // sheet sat above ACES's shoulder, everything below the lip clipped
        // to one flat white block.
        vec3 col = mix(paper * 0.22, paper * 0.72, clamp(m * 1.12 + silver, 0.0, 1.0));
        col = mix(col, paper * 1.0, clamp(foam, 0.0, 1.0));
        col += paper * vec3(0.05, 0.06, 0.07) * silver;   // the metallic edge of the flare
        gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
        #include <fog_fragment>
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  })
);
// centred on the wet channel, which is not the meander line when the banks differ
falls.position.set(FALL_CX, 0, 0);
falls.renderOrder = 2;   // transparents sort by object centre; the river's is much nearer
water.material.uniforms.fallCx.value    = FALL_CX;   // now that the channel is measured
water.material.uniforms.fallHalfW.value = FALL_W / 2;
scene.add(falls);

const fallLayers = [falls];

/* ══════════════════════════════════════════════════════════════
   BAMBOO — instanced segments, node rings, leaves
   ══════════════════════════════════════════════════════════════ */
function leafGeometry() {
  const S = 4, pos = [], uv = [], idx = [];
  for (let i = 0; i <= S; i++) {
    const t = i / S;
    const w = Math.sin(Math.pow(t, 0.72) * Math.PI) * 0.5 * (1 - t * 0.30);
    const bend = -Math.pow(t, 2.6) * 0.10;   // a bamboo blade is nearly flat and stiff
    pos.push(-w, t, bend, w, t, bend);
    uv.push(0, t, 1, t);
  }
  for (let i = 0; i < S; i++) {
    const a = i * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/* The grove is laid out once and never touched again — the wind lives in the
   vertex shader, so no matrices are rebuilt on the CPU per frame. */
const inkMats = [];
/* `light` is the albedo, `dark` what it drifts toward at the tip. Lighting is
   the same sun and sky as the rock, in world space — the old version lit each
   blade from a fixed direction in view space, so the light swung with the eye. */
const inkMat = (dark, light, translucency = 0) => {
  const m = new THREE.ShaderMaterial({
    fog: true, lights: true, side: THREE.DoubleSide,
    uniforms: litUniforms({
      uTime: { value: 0 },
      dark:  { value: new THREE.Color(dark) },
      light: { value: new THREE.Color(light) },
      translucency: { value: translucency },
    }),
    vertexShader: /* glsl */`
      #include <common>
      #include <shadowmap_pars_vertex>
      #include <fog_pars_vertex>
      uniform float uTime;
      attribute vec3 aSwayVec;   // full displacement at peak sway
      attribute vec2 aSwayT;     // (speed, phase)
      attribute vec2 aStalk;     // (base y, height) of the culm this part belongs to
      varying vec2 vUv;
      varying vec3 vWN;
      void main() {
        vUv = uv;
        vec3 objN = normalize(mat3(instanceMatrix) * normal);
        vWN = normalize(mat3(modelMatrix) * objN);

        vec4 worldPosition = modelMatrix * instanceMatrix * vec4(position, 1.0);
        // one continuous quadratic bend per culm, sampled at this vertex's
        // height, so every segment, node, twig and leaf agrees where they meet
        float hf = clamp((worldPosition.y - aStalk.x) / aStalk.y, 0.0, 1.3);
        worldPosition.xyz += aSwayVec * (hf * hf) * sin(uTime * aSwayT.x + aSwayT.y);
        vec3 transformedNormal = normalMatrix * objN;

        vec4 mvPosition = viewMatrix * worldPosition;
        gl_Position = projectionMatrix * mvPosition;
        #include <shadowmap_vertex>
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */`
      #include <common>
      #include <fog_pars_fragment>
      ${SHADOW_PARS_FRAG}
      ${LIGHT_GLSL}
      uniform vec3  dark, light;
      uniform float translucency;
      varying vec2 vUv;
      varying vec3 vWN;
      void main() {
        vec3 N = normalize(vWN);
        N = gl_FrontFacing ? N : -N;
        vec3  albedo = mix(light, dark, vUv.y * 0.35);   // tips darken
        float sh     = getShadowMask();
        vec3  col    = shadeLit(albedo, N, sh, 1.0);
        // a blade is thin enough for the sun to come through from behind
        col += albedo * sunColor * max(dot(-N, sunDir), 0.0) * translucency * sh;
        gl_FragColor = vec4(col, 1.0);
        #include <fog_fragment>
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  inkMats.push(m);
  return m;
};

const stalkGeo  = new THREE.CylinderGeometry(0.92, 1.0, 1, 9, 1, true);
stalkGeo.translate(0, 0.5, 0);
const branchGeo = stalkGeo.clone();
const ringGeo   = new THREE.CylinderGeometry(1.16, 1.16, 1, 9, 1);
const leafGeo   = leafGeometry();

/* build the grove — clusters hugging both banks, biggest nearest the eye */
const stalks = [];
let rs = 20240616;
const rnd = () => { rs = (rs * 1664525 + 1013904223) >>> 0; return rs / 4294967296; };

/* Nothing may stand in the corridor the camera looks down. Panning the aim
   sideways used to walk the sight line straight into the right-bank grove; the
   grove yields instead, so the framing is free to move. */
const sightX = FALL_CX + panX;
const blocksView = (x, z) => z < 36 && z > -24 && Math.abs(x - sightX) < 7.5;

function addStalk(x, z, h, r) {
  if (blocksView(x, z)) return;
  const ground = terrainHeight(x, z);
  // bamboo grows on the bank, never in the stream — clear of both the local
  // waterline (which steps up above the falls) and the channel itself
  if (ground < bedAt(z) + 1.1) return;
  if (Math.abs(x - riverX(z)) < 9.5) return;
  stalks.push({
    x, z,
    base: ground - 0.4,
    h, r,
    segs: 6 + Math.floor(rnd() * 5),
    lean: (rnd() - 0.5) * 0.22,
    dir:  rnd() * Math.PI * 2,
    ph:   rnd() * Math.PI * 2,
    sp:   0.50 + rnd() * 0.60,
    amp:  0.028 + rnd() * 0.050,
  });
}

/* Groves along both banks, receding into the mist. Nothing is placed close
   enough to crowd the lens — the eye should land on the water first. */
for (let c = 0; c < 34; c++) {
  const z    = 6 - Math.pow(rnd(), 0.55) * 150;
  const side = rnd() < 0.5 ? -1 : 1;
  const cx   = riverX(z) + side * (11 + rnd() * 20);
  const n    = 3 + Math.floor(rnd() * 4);
  for (let i = 0; i < n; i++) {
    const x  = cx + (rnd() - 0.5) * 6;
    const zz = z + (rnd() - 0.5) * 7;
    addStalk(x, zz, 10 + rnd() * 11, 0.16 + rnd() * 0.10);
  }
}

/* A light screen on each bank, set back far enough to stay scenery */
for (const side of [-1, 1]) {
  for (let i = 0; i < 6; i++) {
    const z = -6 - rnd() * 22;
    addStalk(riverX(z) + side * (13 + rnd() * 9), z, 13 + rnd() * 9, 0.18 + rnd() * 0.09);
  }
}

/* No gorge-wall culms. Standing that close they read as dark slabs across the
   frame rather than as bamboo, and they were the one thing fighting the fall
   for the eye. The receding groves carry the setting on their own. */

/* Pre-roll the foliage so it doesn't shimmer between frames.
   Bamboo carries nothing on the lower culm, then throws thin side branches
   that each end in a small drooping spray — that silhouette is the whole plant. */
const branchPlan = [], leafPlan = [];
for (let s = 0; s < stalks.length; s++) {
  const st = stalks[s];
  // detail follows the eye: near culms get full sprays, far ones a bare hint
  const near = Math.pow(sstep(-110, 22, st.z), 1.15);

  for (let seg = 0; seg < st.segs; seg++) {
    const f = (seg + 1) / st.segs;
    // far crowns start lower and use fewer, larger blades: same visual mass,
    // a fraction of the geometry
    if (f < 0.45 - (1 - near) * 0.14) continue;

    // fewer branches, denser sprays — scattered twigs read as a dead tree,
    // clumped ones read as a bamboo crown
    const nb = 1 + Math.floor(rnd() * 1.2 + near * 2);
    for (let b = 0; b < nb; b++) {
      const bi = branchPlan.length;
      const bLen = st.h * (0.06 + rnd() * 0.09);
      branchPlan.push({
        // never above the culm's own tip: the top node sat at exactly 1.0 and
        // the jitter pushed its sprays into thin air
        s, f: Math.min(f + (rnd() - 0.5) * 0.08, 0.97),
        yaw:   rnd() * Math.PI * 2,
        len:   bLen,
        droop: 0.02 + rnd() * 0.20,             // branches held out, only a slight bow
        // thick enough to stay on screen — at 0.09 of the culm a twig was
        // sub-pixel, so the leaves along it seemed to hover unattached
        rad:   Math.max(st.r * 0.16, 0.03),
        ph:    rnd() * Math.PI * 2,
      });

      const nl = 7 + Math.floor(rnd() * 2 + near * 4);
      for (let l = 0; l < nl; l++) {
        const len = bLen * (0.42 + rnd() * 0.32) * (1.0 + (1 - near) * 0.5);
        leafPlan.push({
          b: bi,
          // leaves alternate along the twig rather than bunching at its tip
          along:  Math.min(0.30 + (l / Math.max(1, nl - 1)) * 0.70 + (rnd() - 0.5) * 0.09, 1.0),
          // fanned to alternating sides OF THE BRANCH, not of the world
          spread: (l % 2 ? 1 : -1) * (0.18 + rnd() * 0.38),
          droop:  -0.36 + rnd() * 0.26,         // blades angle up and outward, crisp rather than hanging
          len,
          wid:    len * (0.085 + rnd() * 0.04), // a bamboo leaf is ~10× longer than wide
          ph:     rnd() * Math.PI * 2,
        });
      }
    }
  }
}

const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler();
const P = new THREE.Vector3(), S3 = new THREE.Vector3();
const ORIGIN = new THREE.Vector3(), DIR = new THREE.Vector3(), TIP = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

const segD = [], ringD = [], branchD = [], leafD = [];
/* Sway is a single smooth bend per culm, evaluated per vertex from its height
   in the shader. Each part carries the culm's full-height amplitude and its
   (base, height); before, every segment was rigidly shifted by the amount at
   its own foot, so neighbouring segments moved by different amounts and the
   culm came apart at every node in the wind. */
const push = (arr, mat, sx, sy, sz, speed, phase, st) =>
  arr.push({ m: mat.clone(), s: [sx, sy, sz], t: [speed, phase], k: [st.base, st.h] });

/* culms and their node rings, at rest */
for (const st of stalks) {
  const segH = st.h / st.segs;
  const dx = Math.cos(st.dir), dz = Math.sin(st.dir);
  const showRings = sstep(-110, 22, st.z) > 0.42;   // node rings only up close

  for (let s = 0; s < st.segs; s++) {
    const f0 = s / st.segs, f1 = (s + 1) / st.segs;
    // the culm curves: displacement grows with the square of the height
    const bend0 = st.lean * f0 * f0 * st.h;
    const bend1 = st.lean * f1 * f1 * st.h;
    const y0 = st.base + f0 * st.h;
    const tilt = Math.atan2(bend1 - bend0, segH);
    const rad = st.r * (1 - f0 * 0.34);

    P.set(st.x + dx * bend0, y0, st.z + dz * bend0);
    E.set(tilt * Math.sin(st.dir), 0, -tilt * Math.cos(st.dir));
    Q.setFromEuler(E);

    const amp = reduceMotion ? 0 : st.amp * st.h;   // displacement at the tip
    S3.set(rad, segH * 1.02, rad);
    push(segD, M.compose(P, Q, S3), dx * amp, 0, dz * amp, st.sp, st.ph, st);

    if (s > 0 && showRings) {
      S3.set(rad, st.r * 0.30, rad);
      push(ringD, M.compose(P, Q, S3), dx * amp, 0, dz * amp, st.sp, st.ph, st);
    }
  }
}

/* side branches, each remembering its tip so a spray can hang off it */
for (const br of branchPlan) {
  const st = stalks[br.s];
  const bend = st.lean * br.f * br.f * st.h;

  ORIGIN.set(
    st.x + Math.cos(st.dir) * bend,
    st.base + br.f * st.h,
    st.z + Math.sin(st.dir) * bend
  );
  DIR.set(Math.cos(br.yaw), -br.droop, Math.sin(br.yaw)).normalize();
  br._org = ORIGIN.clone();
  br._dir = DIR.clone();

  const amp = reduceMotion ? 0 : st.amp * st.h;     // the culm's, not this node's
  br._sway = [Math.cos(st.dir) * amp, 0, Math.sin(st.dir) * amp];
  br._t    = [st.sp, st.ph];

  Q.setFromUnitVectors(UP, DIR);
  S3.set(br.rad, br.len, br.rad);
  push(branchD, M.compose(ORIGIN, Q, S3), ...br._sway, st.sp, st.ph, st);
}

/* Every leaf is built in its own branch's frame: it continues along the twig,
   fans to one side of it, and hangs. Orienting leaves in world space instead
   is what made the sprays look scattered. */
const LDIR = new THREE.Vector3(), SIDE = new THREE.Vector3();
const XA = new THREE.Vector3(), YA = new THREE.Vector3(), ZA = new THREE.Vector3();

for (const lf of leafPlan) {
  const br = branchPlan[lf.b];
  TIP.copy(br._dir).multiplyScalar(br.len * lf.along).add(br._org);

  SIDE.crossVectors(UP, br._dir);
  if (SIDE.lengthSq() < 1e-6) SIDE.set(1, 0, 0);
  SIDE.normalize();

  LDIR.copy(br._dir).multiplyScalar(Math.cos(lf.spread))
      .addScaledVector(SIDE, Math.sin(lf.spread))
      .addScaledVector(UP, -lf.droop)
      .normalize();

  // blade runs along +Y; its curl (toward -Z) must fall downward
  YA.copy(LDIR);
  ZA.copy(UP).addScaledVector(YA, -UP.dot(YA));
  if (ZA.lengthSq() < 1e-6) ZA.set(0, 0, 1);
  ZA.normalize();
  XA.crossVectors(YA, ZA).normalize();

  S3.set(lf.wid, lf.len, lf.len);
  M.makeBasis(XA, YA, ZA).scale(S3).setPosition(TIP);
  push(leafD, M, ...br._sway, br._t[0], br._t[1], stalks[br.s]);
}

function buildMesh(geo, mat, data) {
  const n = data.length;
  const mesh = new THREE.InstancedMesh(geo, mat, n);
  const sway = new Float32Array(n * 3);
  const time = new Float32Array(n * 2);
  const stalk = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    mesh.setMatrixAt(i, data[i].m);
    sway.set(data[i].s, i * 3);
    time.set(data[i].t, i * 2);
    stalk.set(data[i].k, i * 2);
  }
  geo.setAttribute('aSwayVec', new THREE.InstancedBufferAttribute(sway, 3));
  geo.setAttribute('aSwayT',   new THREE.InstancedBufferAttribute(time, 2));
  geo.setAttribute('aStalk',   new THREE.InstancedBufferAttribute(stalk, 2));
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}

buildMesh(stalkGeo,  inkMat('#1a2620', '#3f5238'), segD);
buildMesh(ringGeo,   inkMat('#161f14', '#2b3824'), ringD);
buildMesh(branchGeo, inkMat('#18231a', '#33452f'), branchD);
buildMesh(leafGeo,   inkMat('#223020', '#46583a', 0.45), leafD);
console.log(`bamboo:  culms · ${branchD.length} branches · ${leafD.length} leaves`);

/* Contact occlusion for the grove: the ground's ambient darkens around each
   culm's foot, so bamboo stands in the earth instead of on top of it. Folded
   into the terrain's baked AO — no extra cost at runtime. */
{
  const W1 = SEG + 1, R = 2.6;
  for (const st of stalks) {
    const cx = (st.x + TW / 2) / CELL_X, cy = (TD / 2 + st.z) / CELL_Y;
    const rx = Math.ceil(R / CELL_X), ry = Math.ceil(R / CELL_Y);
    for (let iy = Math.floor(cy) - ry; iy <= Math.ceil(cy) + ry; iy++) {
      for (let ix = Math.floor(cx) - rx; ix <= Math.ceil(cx) + rx; ix++) {
        if (ix < 0 || iy < 0 || ix > SEG || iy > SEG) continue;
        const d = Math.hypot((ix - cx) * CELL_X, (iy - cy) * CELL_Y);
        if (d > R) continue;
        terrainAO[iy * W1 + ix] *= 1 - 0.32 * (1 - d / R) ** 2;
      }
    }
  }
  tGeo.attributes.aAO.needsUpdate = true;
}

/* ══════════════════════════════════════════════════════════════
   MIST — the white that separates one range from the next
   ══════════════════════════════════════════════════════════════ */
function mistTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const rg = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  rg.addColorStop(0,   'rgba(255,255,255,0.92)');
  rg.addColorStop(0.42,'rgba(255,255,255,0.44)');
  rg.addColorStop(1,   'rgba(255,255,255,0)');
  g.fillStyle = rg; g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}
const mistTex = mistTexture();
const mists = [];
/* Keep the haze off the near field. A sprite this size sitting between the eye
   and the valley spans the whole frame and lays a pale slab over everything —
   it was reading as a river far wider than the fall it feeds. */
for (let i = 0; i < 26; i++) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: mistTex, transparent: true, depthWrite: false,
    opacity: 0.10 + rnd() * 0.20, color: SKY,
  }));
  const z = -26 - rnd() * 165;
  sp.position.set((rnd() - 0.5) * 200, 1.4 + rnd() * 16, z);
  const s = 26 + rnd() * 56;
  sp.scale.set(s, s * (0.20 + rnd() * 0.16), 1);
  sp.userData = { sp: 0.10 + rnd() * 0.26, ph: rnd() * Math.PI * 2, y: sp.position.y };
  mists.push(sp); scene.add(sp);
}

/* Spray thrown up where the stream lands, plus an additive bloom over the
   sheet itself — the falls should read as the one lit thing in the valley. */
for (let i = 0; i < 12; i++) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: mistTex, transparent: true, depthWrite: false,
    opacity: 0.16 + rnd() * 0.20, color: SKY,
  }));
  sp.position.set(
    FALL_CX + (rnd() - 0.5) * 18,
    0.4 + rnd() * 5.5,
    FALL_BOT + 1 + rnd() * 9
  );
  const s = 9 + rnd() * 13;
  sp.scale.set(s, s * (0.40 + rnd() * 0.28), 1);
  sp.userData = { sp: 0, ph: rnd() * Math.PI * 2, y: sp.position.y };
  mists.push(sp); scene.add(sp);
}
/* a low veil at the foot only — glow across the cliff itself would bleach the
   rock that the water needs to read against */
for (let i = 0; i < 4; i++) {
  const gl = new THREE.Sprite(new THREE.SpriteMaterial({
    map: mistTex, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, opacity: 0.07 + rnd() * 0.07,
    color: new THREE.Color('#dbeaf2'),
  }));
  gl.position.set(
    riverX(FALL_BOT) + (rnd() - 0.5) * 14,
    0.8 + rnd() * 2.6,
    FALL_BOT + 1 + rnd() * 5
  );
  const s = 12 + rnd() * 12;
  gl.scale.set(s, s * 0.55, 1);
  gl.userData = { sp: 0, ph: rnd() * Math.PI * 2, y: gl.position.y };
  mists.push(gl); scene.add(gl);
}

/* Birds — two strokes of the brush, nothing more */
function birdTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.strokeStyle = 'rgba(30,48,60,0.85)';
  g.lineWidth = 3; g.lineCap = 'round';
  g.beginPath();
  g.moveTo(6, 34); g.quadraticCurveTo(20, 20, 32, 30);
  g.quadraticCurveTo(44, 20, 58, 34);
  g.stroke();
  return new THREE.CanvasTexture(c);
}
const birdTex = birdTexture();
const birds = [];
/* A skein crossing the notch of sky above the falls. Exempt from fog: at this
   range it erased them, and a bird in an ink painting stays a clean dark mark
   however far off it is — that is the whole convention. */
for (let i = 0; i < 14; i++) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: birdTex, transparent: true, depthWrite: false, fog: false,
    opacity: 0.45 + rnd() * 0.35,
  }));
  // Biased off to one side and high: dead centre is where a portrait or a
  // headline sits, and a bird behind either is a bird nobody sees.
  // Over the notch of sky above the fall: high enough to clear the ridgeline,
  // low enough to stay inside a frame that is only tilted 7° upward, and near
  // the valley axis where there is open sky rather than mountain behind them.
  const z = -50 - rnd() * 45;
  const side = rnd() < 0.5 ? -1 : 1;
  sp.position.set(FALL_CX + side * (5 + rnd() * 22), 40 + rnd() * 14, z);
  const s = 2.6 + rnd() * 2.6;
  sp.scale.set(s, s, 1);
  sp.userData = { sp: 1.1 + rnd() * 1.4, ph: rnd() * Math.PI * 2, y: sp.position.y };
  birds.push(sp); scene.add(sp);
}

/* ── input ──────────────────────────────────────────────────────
   Drag to look around, scroll to close in on the falls. The scripted
   drift keeps running until the first touch, then hands over for good.
   The hero omits all of this: a canvas that swallowed the wheel would
   stop the page scrolling. */
let controls = null, userDriving = false;
if (interactive) {
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.055;
  controls.rotateSpeed = 0.45;
  controls.zoomSpeed = 0.85;
  controls.panSpeed = 0.6;
  controls.minDistance = 3;
  controls.maxDistance = 190;
  controls.maxPolarAngle = Math.PI * 0.495;   // never duck below the waterline
  controls.target.set(FALL_CX, FALL_H * 0.40, FALL_BOT - 2);
  controls.addEventListener('start', () => { userDriving = true; });
}

const ptr = { x: 0, y: 0 }, aim = { x: 0, y: 0 };
const onPointer = e => {
  const r = canvas.getBoundingClientRect();
  aim.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  aim.y = ((e.clientY - r.top) / r.height) * 2 - 1;
};
addEventListener('pointermove', onPointer);

// Track the canvas box rather than the window: in the hero it is a band whose
// height can change without the window ever resizing.
const ro = new ResizeObserver(() => {
  const s = sizeOf();
  if (s.w === VW && s.h === VH) return;      // no-op resizes would loop
  VW = s.w; VH = s.h;
  camera.aspect = VW / VH;
  camera.updateProjectionMatrix();
  renderer.setSize(VW, VH, false);
});
ro.observe(box);

// Don't burn a GPU on a scene that has scrolled out of sight.
let onScreen = true, running = true;
const io = 'IntersectionObserver' in window
  ? new IntersectionObserver(es => { onScreen = es[0].isIntersecting; }, { threshold: 0 })
  : null;
if (io) io.observe(canvas);

/* ── loop ───────────────────────────────────────────────────── */
const look = new THREE.Vector3(FALL_CX + panX, 19, FALL_BOT - 4);
const clock = new THREE.Clock();

function frame() {
  if (!running) return;
  requestAnimationFrame(frame);
  if (!onScreen) return;

  const t = clock.getElapsedTime();
  ptr.x += (aim.x - ptr.x) * 0.035;
  ptr.y += (aim.y - ptr.y) * 0.035;

  if (userDriving) {
    controls.update();
  } else {
    // stood well back, so the whole fall and the cliff it comes over are in frame
    // Low and looking up: it puts the sky above the gorge in frame, which is
    // the only ground the birds have to read against.
    camera.position.x = FALL_CX + panX + 2.5 + ptr.x * 4.0 + Math.sin(t * 0.10) * 1.3;
    camera.position.y = 7.5 - ptr.y * 2.2 + Math.sin(t * 0.14) * 0.35;
    camera.position.z = 34 + Math.cos(t * 0.08) * 1.2;
    camera.lookAt(look);
  }

  sky.position.copy(camera.position);
  water.material.uniforms.uTime.value = t;
  for (const f of fallLayers) f.material.uniforms.uTime.value = t;
  for (const m of inkMats) m.uniforms.uTime.value = t;

  for (const m of mists) {
    m.position.x += m.userData.sp * 0.016;
    if (m.position.x > 118) m.position.x = -118;
    m.position.y = m.userData.y + Math.sin(t * 0.22 + m.userData.ph) * 0.7;
  }
  for (const b of birds) {
    b.position.x += b.userData.sp * 0.030;
    if (b.position.x > 78) b.position.x = -78;
    b.position.y = b.userData.y + Math.sin(t * 0.55 + b.userData.ph) * 1.3;
  }

  renderer.render(scene, camera);
}
frame();

return {
  dispose() {
    running = false;
    if (io) io.disconnect();
    removeEventListener('pointermove', onPointer);
    ro.disconnect();
    renderer.dispose();
  },
};
}
