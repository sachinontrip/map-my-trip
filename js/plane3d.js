// A small lit 3D airliner rendered with three.js into an offscreen canvas,
// then drawn onto the overlay like any other icon (so preview and export match).
import * as THREE from '../vendor/three.module.min.js';

const RES = 320;
let R = null;

function swept(points, depth, mat) {
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 1 });
  g.translate(0, 0, -depth / 2);
  return new THREE.Mesh(g, mat);
}

function build() {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(RES, RES, false);
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-5, 5, 5, -5, -50, 50);
  cam.position.set(0, 0, 20);
  cam.lookAt(0, 0, 0);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2.4);
  sun.position.set(-4, 6, 10);
  scene.add(sun);

  const white = new THREE.MeshStandardMaterial({ color: 0xf4f6fa, roughness: 0.35, metalness: 0.15 });
  const grey = new THREE.MeshStandardMaterial({ color: 0x9aa3b2, roughness: 0.4, metalness: 0.5 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1b2433, roughness: 0.2, metalness: 0.3 });
  const tail = new THREE.MeshStandardMaterial({ color: 0xff3b5c, roughness: 0.4 });

  // tilt (camera pitch) → yaw (heading) → body (pitch/roll)
  const tilt = new THREE.Group(), yaw = new THREE.Group(), body = new THREE.Group();
  tilt.add(yaw); yaw.add(body); scene.add(tilt);

  // fuselage along +Y (nose), Z is "up" from the ground
  const fus = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 5.6, 6, 18), white);
  body.add(fus);
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.42, 18, 12), white);
  nose.scale.set(1, 1.6, 1); nose.position.y = 3.0;
  body.add(nose);
  const cockpit = new THREE.Mesh(new THREE.SphereGeometry(0.3, 14, 10), dark);
  cockpit.scale.set(1.1, 0.9, 0.6); cockpit.position.set(0, 3.25, 0.22);
  body.add(cockpit);

  // swept wings (shape in XY plane = top view)
  const wing = swept([[0.3, 0.9], [4.3, -1.1], [4.3, -1.6], [0.3, -0.9]], 0.12, white);
  const wingL = wing.clone(); wingL.scale.x = -1;
  for (const w of [wing, wingL]) { w.position.z = -0.12; body.add(w); }
  // engines under the wings
  for (const sx of [-1, 1]) {
    const eng = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.22, 1.1, 16), grey);
    eng.position.set(sx * 1.6, 0.05, -0.38);
    body.add(eng);
    const intake = new THREE.Mesh(new THREE.CircleGeometry(0.2, 16), dark);
    intake.rotation.x = -Math.PI / 2; intake.position.set(sx * 1.6, 0.61, -0.38);
    body.add(intake);
  }
  // tailplane + fin
  const stab = swept([[0.15, -2.4], [1.7, -3.3], [1.7, -3.6], [0.15, -3.2]], 0.08, white);
  const stabL = stab.clone(); stabL.scale.x = -1;
  body.add(stab, stabL);
  // fin: drawn side-on (x = backwards along the body, y = up), then stood upright
  const fin = swept([[0, 0.3], [1.5, 0.3], [1.8, 1.9], [1.2, 1.9]], 0.1, tail);
  fin.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(
    new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(-1, 0, 0)));
  fin.position.set(0, -2.0, 0);
  body.add(fin);

  R = { renderer, scene, cam, tilt, yaw, body, tailMat: tail };
}

/**
 * Render the plane. heading: radians clockwise from screen-up; mapPitch: map tilt in degrees;
 * bank/climb: radians. Returns the canvas (RES×RES), plane centred.
 */
export function renderPlane({ heading, mapPitch = 0, bank = 0, climb = 0, color = '#ff3b5c' }) {
  if (!R) build();
  R.tailMat.color.set(color);
  R.tilt.rotation.x = -(mapPitch * Math.PI / 180) * 0.8;
  R.yaw.rotation.z = -heading;
  R.body.rotation.set(climb, bank, 0, 'XYZ');
  R.renderer.render(R.scene, R.cam);
  return R.renderer.domElement;
}

export const PLANE_RES = RES;
