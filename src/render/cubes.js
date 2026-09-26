// Instanced cubes with per-instance position / rotation / colour / animation,
// lit by MeshStandardMaterial and casting shadows through a matching depth material.
import * as THREE from 'three';

const CELL = 0.94;

const HEAD = /* glsl */ `
attribute vec3 aPos;
attribute vec4 aQuat;
attribute vec3 aCol;
attribute vec4 aAnim;   // x: born at, y: slide started at, z: vanish started at, w: slide duration
attribute vec3 aSlide;  // offset the cube slides in from (falls use a gravity ease-in)
attribute float aHeat;  // emissive glow
uniform float uTime;
varying vec3 vCol;
varying vec3 vLocal;
varying float vHeat;
vec3 qrot(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
`;

const XFORM = /* glsl */ `
  float grow = clamp((uTime - aAnim.x) / 0.25, 0.0, 1.0);
  float s = grow * grow * (3.0 - 2.0 * grow);
  if (aAnim.z > 0.0) s *= 1.0 - smoothstep(0.0, 0.45, uTime - aAnim.z);
  float u = clamp((uTime - aAnim.y) / max(aAnim.w, 0.05), 0.0, 1.0);
  float sl = 1.0 - u * u;
  vec3 transformed = qrot(aQuat, position * (${CELL.toFixed(2)} * s)) + aPos + aSlide * sl;
`;

function inject(shader, { lit }) {
  shader.uniforms.uTime = { value: 0 };
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${HEAD}`)
    .replace('#include <begin_vertex>', `${XFORM}\n  vLocal = position; vCol = aCol; vHeat = aHeat;`);
  if (lit) {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <beginnormal_vertex>',
      'vec3 objectNormal = qrot(aQuat, vec3(normal));\n#ifdef USE_TANGENT\nvec3 objectTangent = vec3(tangent.xyz);\n#endif',
    );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCol;\nvarying vec3 vLocal;\nvarying float vHeat;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec3 a = abs(vLocal);
        float mx = max(max(a.x, a.y), a.z);
        float mn = min(min(a.x, a.y), a.z);
        float mid = a.x + a.y + a.z - mx - mn;       // distance from the face centre toward its nearest edge
        float edge = smoothstep(0.5, 0.40, mid);
        diffuseColor.rgb *= vCol * mix(0.55, 1.0, edge);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n totalEmissiveRadiance += vCol * vHeat;',
      );
  }
}

export function makeCubeMesh(capacity, { roughness = 0.62, metalness = 0.04 } = {}) {
  const box = new THREE.BoxGeometry(1, 1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = box.index;
  geo.setAttribute('position', box.getAttribute('position'));
  geo.setAttribute('normal', box.getAttribute('normal'));
  const attr = (name, size) => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size);
    a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute(name, a);
    return a;
  };
  const attrs = {
    pos: attr('aPos', 3),
    quat: attr('aQuat', 4),
    col: attr('aCol', 3),
    anim: attr('aAnim', 4),
    slide: attr('aSlide', 3),
    heat: attr('aHeat', 1),
  };
  for (let i = 0; i < capacity; i++) attrs.quat.array[i * 4 + 3] = 1;
  geo.instanceCount = 0;

  const uniforms = [];
  const material = new THREE.MeshStandardMaterial({ roughness, metalness });
  material.onBeforeCompile = (shader) => {
    inject(shader, { lit: true });
    uniforms.push(shader.uniforms.uTime);
  };
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.onBeforeCompile = (shader) => {
    inject(shader, { lit: false });
    uniforms.push(shader.uniforms.uTime);
  };
  const mesh = new THREE.Mesh(geo, material);
  mesh.customDepthMaterial = depth;
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  return {
    mesh,
    attrs,
    capacity,
    setTime(t) {
      for (const u of uniforms) u.value = t;
    },
    // Upload the first `count` instances of the named attributes.
    commit(count, names) {
      geo.instanceCount = count;
      if (count === 0) return;
      for (const name of names) {
        const a = attrs[name];
        a.clearUpdateRanges();
        a.addUpdateRange(0, count * a.itemSize);
        a.needsUpdate = true;
      }
    },
  };
}
