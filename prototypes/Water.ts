import {
  Mesh,
  PlaneGeometry,
  Color,
  DoubleSide,
  MeshStandardNodeMaterial,
} from 'three/webgpu';
import {
  float,
  vec4,
  vec3,
  uniform,
  color,
  screenUV,
  viewportDepthTexture,
  viewportDepth,
  uv,
  time,
  sin,
  mix,
  step,
} from 'three/tsl';

export function createWaterMaterial(
  baseColor?: Color,
  foamColor?: Color,
  foamWidth?: number,
): MeshStandardNodeMaterial {
  const base = baseColor ?? new Color(0x3a9ec8);
  const foam = foamColor ?? new Color(0xffffff);
  const width = foamWidth ?? 0.08;

  const foamWidthNode = uniform(width);

  // Scene depth comparison for foam at intersection edges
  const depthTex = viewportDepthTexture();
  const sceneDepth = depthTex.r;
  const fragDepth = viewportDepth;
  const thickness = sceneDepth.sub(fragDepth);

  // Sharp white foam where water thickness is below threshold
  const foamMask = step(thickness, foamWidthNode);

  // Gentle wave motion
  const wave = sin(time.add(uv().x.mul(6)).add(uv().y.mul(4))).mul(0.006);

  // Animate base color slightly
  const mixedBase = mix(color(base.getHex()), color(0x5abcee), sin(time.mul(0.2)).mul(0.5).add(0.5));

  // Apply foam: white where mask=1, colored water elsewhere
  const finalColor = mix(mixedBase.add(wave), color(foam.getHex()), foamMask);

  const mat = new MeshStandardNodeMaterial();
  mat.colorNode = vec4(finalColor, 1);
  mat.opacityNode = float(0.85);
  mat.transparent = true;
  mat.side = DoubleSide;
  mat.roughness = float(0.3);
  mat.metalness = float(0);
  mat.depthWrite = false;
  mat.depthTest = true;

  return mat;
}

export function createWaterMesh(
  width?: number,
  height?: number,
  material?: MeshStandardNodeMaterial,
): Mesh {
  const w = width ?? 20;
  const h = height ?? 20;
  const geo = new PlaneGeometry(w, h);
  geo.rotateX(-Math.PI / 2);
  const mat = material ?? createWaterMaterial();
  const mesh = new Mesh(geo, mat);
  mesh.renderOrder = 1;
  mesh.frustumCulled = false;
  return mesh;
}
