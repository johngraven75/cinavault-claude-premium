// Vault's procedural low-poly head, rendered with React Three Fiber.
//
// Built from primitives at runtime: no model download, nothing fetched from a
// CDN. Joints are named groups (HEAD_RIG) so the same pose data could drive a
// bundled glTF head later. Each frame samples computeHeadPose for the current
// mode and damps toward it, so idle drift, blinks, breathing, glances and
// lip sync all blend instead of snapping.
import { useEffect, useMemo, useRef } from "react";
import type { JSX, MutableRefObject } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { MathUtils, type Group, type Mesh, type MeshStandardMaterial } from "three";
import { computeHeadPose, mouthAt, type HeadMode, type HeadPose } from "../../services/aiAgentState";

export interface SpeechCue {
  text: string;
  /** performance.now() when speaking started. */
  startedAt: number;
}

interface AgentHeadProps {
  mode: HeadMode;
  speechRef: MutableRefObject<SpeechCue | null>;
  reducedMotion: boolean;
  size?: number;
}

const SKIN = "#27364f";
const SKIN_EDGE = "#22d3ee";
const HAIR = "#0b1222";
const LIP = "#41506e";
const LID_OPEN = -0.55;
const LID_CLOSED = 1.45;
const JAW_MAX = 0.32;

type Joints = Record<"neck" | "head" | "jaw" | "irisL" | "irisR" | "lidL" | "lidR" | "browL" | "browR", Group | null>;

function Rig({ mode, speechRef, reducedMotion }: Omit<AgentHeadProps, "size">): JSX.Element {
  const joints = useRef<Joints>({
    neck: null, head: null, jaw: null, irisL: null, irisR: null,
    lidL: null, lidR: null, browL: null, browR: null,
  });
  const skin = useRef<MeshStandardMaterial>(null);
  const halo = useRef<Mesh>(null);
  const pose = useRef<HeadPose>(computeHeadPose("idle", 0));
  const { invalidate } = useThree();

  // Under reduced motion the canvas renders on demand; redraw once per mode change.
  useEffect(() => {
    if (reducedMotion) invalidate();
  }, [mode, reducedMotion, invalidate]);

  useFrame((state, delta) => {
    const j = joints.current;
    const t = reducedMotion ? 0 : state.clock.elapsedTime;
    const cue = speechRef.current;
    const mouth = cue && !reducedMotion ? mouthAt(cue.text, (performance.now() - cue.startedAt) / 1000) : 0;
    const target = computeHeadPose(mode, t, mouth);
    const p = pose.current;
    const dt = reducedMotion ? 1 : Math.min(delta, 0.1);

    p.yaw = MathUtils.damp(p.yaw, target.yaw, 4, dt);
    p.pitch = MathUtils.damp(p.pitch, target.pitch, 4, dt);
    p.roll = MathUtils.damp(p.roll, target.roll, 4, dt);
    p.eyeX = MathUtils.damp(p.eyeX, target.eyeX, 12, dt);
    p.eyeY = MathUtils.damp(p.eyeY, target.eyeY, 12, dt);
    p.mouthOpen = MathUtils.damp(p.mouthOpen, target.mouthOpen, 22, dt);
    p.brow = MathUtils.damp(p.brow, target.brow, 6, dt);
    p.glow = MathUtils.damp(p.glow, target.glow, 3, dt);
    p.blink = reducedMotion ? 0 : target.blink;
    p.breath = target.breath;

    if (j.neck) j.neck.scale.set(1 + p.breath, 1 + p.breath * 0.5, 1 + p.breath);
    if (j.head) {
      j.head.rotation.set(p.pitch, p.yaw, p.roll);
      j.head.position.y = 1.05 + p.breath * 2;
    }
    if (j.jaw) j.jaw.rotation.x = p.mouthOpen * JAW_MAX;
    for (const iris of [j.irisL, j.irisR]) {
      if (iris) iris.position.set(p.eyeX * 0.045, p.eyeY * 0.035, 0.1);
    }
    const lid = MathUtils.lerp(LID_OPEN, LID_CLOSED, p.blink);
    if (j.lidL) j.lidL.rotation.x = lid;
    if (j.lidR) j.lidR.rotation.x = lid;
    if (j.browL) {
      j.browL.position.y = 0.34 + p.brow * 0.04;
      j.browL.rotation.z = -0.12 - p.brow * 0.12;
    }
    if (j.browR) {
      j.browR.position.y = 0.34 + p.brow * 0.04;
      j.browR.rotation.z = 0.12 + p.brow * 0.12;
    }
    if (skin.current) skin.current.emissiveIntensity = 0.08 + p.glow * 0.22;
    if (halo.current) {
      halo.current.rotation.z += reducedMotion ? 0 : delta * (0.3 + p.glow);
      const s = 1 + p.glow * 0.06;
      halo.current.scale.set(s, s, s);
    }
  });

  const set = (name: keyof Joints) => (node: Group | null) => {
    joints.current[name] = node;
  };

  const eye = (side: -1 | 1) => {
    const L = side === -1;
    return (
      <group name={L ? "eye_L" : "eye_R"} position={[side * 0.3, 0.14, 0.7]}>
        <mesh>
          <sphereGeometry args={[0.13, 20, 14]} />
          <meshStandardMaterial color="#dff4ff" emissive="#7dd3fc" emissiveIntensity={0.15} roughness={0.3} />
        </mesh>
        <group ref={set(L ? "irisL" : "irisR")} position={[0, 0, 0.1]}>
          <mesh>
            <sphereGeometry args={[0.062, 16, 12]} />
            <meshStandardMaterial color="#0891b2" emissive="#22d3ee" emissiveIntensity={0.6} />
          </mesh>
          <mesh position={[0, 0, 0.035]}>
            <sphereGeometry args={[0.032, 12, 10]} />
            <meshBasicMaterial color="#020617" />
          </mesh>
        </group>
        <group ref={set(L ? "lidL" : "lidR")} name={L ? "lid_L" : "lid_R"} rotation={[LID_OPEN, 0, 0]}>
          <mesh>
            <sphereGeometry args={[0.145, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2]} />
            <meshStandardMaterial color={SKIN} flatShading roughness={0.5} />
          </mesh>
        </group>
      </group>
    );
  };

  return (
    <group position={[0, -0.95, 0]}>
      <mesh ref={halo} position={[0, -0.2, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.95, 0.012, 8, 72]} />
        <meshBasicMaterial color={SKIN_EDGE} transparent opacity={0.55} />
      </mesh>
      <group ref={set("neck")} name="neck">
        <mesh position={[0, 0.25, -0.05]}>
          <cylinderGeometry args={[0.32, 0.4, 0.7, 7]} />
          <meshStandardMaterial color={SKIN} flatShading roughness={0.55} metalness={0.25} />
        </mesh>
        <group ref={set("head")} name="head" position={[0, 1.05, 0]}>
          {/* Skull: a faceted icosphere reads as stylised low-poly. */}
          <mesh scale={[0.82, 1, 0.9]}>
            <icosahedronGeometry args={[1, 2]} />
            <meshStandardMaterial
              ref={skin}
              color={SKIN}
              emissive={SKIN_EDGE}
              emissiveIntensity={0.15}
              flatShading
              roughness={0.45}
              metalness={0.3}
            />
          </mesh>
          <mesh position={[0, 0.42, -0.1]} scale={[0.86, 0.6, 0.95]}>
            <icosahedronGeometry args={[1.02, 1]} />
            <meshStandardMaterial color={HAIR} flatShading roughness={0.8} />
          </mesh>
          {[-1, 1].map((side) => (
            <mesh key={side} position={[side * 0.8, 0.04, -0.02]} scale={[0.32, 0.55, 0.24]}>
              <icosahedronGeometry args={[0.5, 1]} />
              <meshStandardMaterial color={SKIN} flatShading />
            </mesh>
          ))}
          <group ref={set("browL")} name="brow_L" position={[-0.3, 0.34, 0.8]}>
            <mesh>
              <boxGeometry args={[0.3, 0.055, 0.08]} />
              <meshStandardMaterial color={HAIR} />
            </mesh>
          </group>
          <group ref={set("browR")} name="brow_R" position={[0.3, 0.34, 0.8]}>
            <mesh>
              <boxGeometry args={[0.3, 0.055, 0.08]} />
              <meshStandardMaterial color={HAIR} />
            </mesh>
          </group>
          {eye(-1)}
          {eye(1)}
          <mesh position={[0, -0.06, 0.9]} rotation={[Math.PI / 2 - 0.25, Math.PI / 4, 0]} scale={[1, 1, 0.75]}>
            <coneGeometry args={[0.1, 0.32, 4]} />
            <meshStandardMaterial color={SKIN} flatShading />
          </mesh>
          {/* Mouth cavity and upper lip stay with the skull; the jaw carries the lower lip. */}
          <mesh position={[0, -0.43, 0.74]}>
            <boxGeometry args={[0.3, 0.16, 0.06]} />
            <meshBasicMaterial color="#03060c" />
          </mesh>
          <mesh position={[0, -0.36, 0.8]}>
            <boxGeometry args={[0.36, 0.05, 0.08]} />
            <meshStandardMaterial color={LIP} />
          </mesh>
          <group ref={set("jaw")} name="jaw" position={[0, -0.1, -0.1]}>
            <mesh position={[0, -0.47, 0.42]} scale={[0.95, 0.42, 0.9]}>
              <icosahedronGeometry args={[0.6, 1]} />
              <meshStandardMaterial color={SKIN} flatShading roughness={0.5} metalness={0.25} />
            </mesh>
            <mesh position={[0, -0.31, 0.89]}>
              <boxGeometry args={[0.34, 0.055, 0.08]} />
              <meshStandardMaterial color={LIP} />
            </mesh>
            <mesh position={[0, -0.66, 0.72]}>
              <dodecahedronGeometry args={[0.17, 0]} />
              <meshStandardMaterial color={SKIN} flatShading />
            </mesh>
          </group>
        </group>
      </group>
    </group>
  );
}

export default function AgentHead({ mode, speechRef, reducedMotion, size = 220 }: AgentHeadProps): JSX.Element {
  const camera = useMemo(() => ({ position: [0, 0.05, 4.6] as [number, number, number], fov: 32 }), []);
  return (
    <div style={{ width: size, height: size }} aria-hidden="true">
      <Canvas
        camera={camera}
        dpr={[1, 1.75]}
        frameloop={reducedMotion ? "demand" : "always"}
        gl={{ antialias: true, alpha: true, powerPreference: "low-power" }}
      >
        <ambientLight intensity={0.45} />
        <directionalLight position={[2, 3, 4]} intensity={1.4} />
        <pointLight position={[-2.5, 0.5, 1.5]} intensity={6} color="#22d3ee" />
        <pointLight position={[2.5, -0.5, -1.5]} intensity={5} color="#d946ef" />
        <Rig mode={mode} speechRef={speechRef} reducedMotion={reducedMotion} />
      </Canvas>
    </div>
  );
}
