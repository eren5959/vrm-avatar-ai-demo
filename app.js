// app.js — simple client-side VRM viewer + AI chat demo
import * as THREE from 'https://unpkg.com/three@0.152.2/build/three.module.js';
import { GLTFLoader } from 'https://unpkg.com/three@0.152.2/examples/jsm/loaders/GLTFLoader.js';
import * as THREE_EXTRAS from 'https://unpkg.com/three@0.152.2/examples/jsm/controls/OrbitControls.js';
import { VRM, VRMUtils, VRMLookAt } from 'https://unpkg.com/@pixiv/three-vrm@1.0.0-beta.5/dist/three-vrm.module.js';

let renderer, scene, camera, clock, mixer;
let vrm = null;
let headBone = null;

const canvas = document.getElementById('canvas');
const overlayNotice = document.getElementById('overlayNotice');
const vrmFile = document.getElementById('vrmFile');
const apiKeyInput = document.getElementById('apiKey');
const providerSel = document.getElementById('provider');
const customEndpointInput = document.getElementById('customEndpoint');
const customEndpointLabel = document.getElementById('customEndpointLabel');
const chatLog = document.getElementById('chatLog');
const messageInput = document.getElementById('message');
const sendBtn = document.getElementById('send');

init();

function init(){
  // Renderer
  renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  resize();
  window.addEventListener('resize', resize);

  // Scene
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(45, canvas.clientWidth / canvas.clientHeight, 0.1, 20);
  camera.position.set(0.0, 1.4, 2.0);

  const light = new THREE.DirectionalLight(0xffffff);
  light.position.set(1, 1, 1).normalize();
  scene.add(light);

  const amb = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(amb);

  clock = new THREE.Clock();
  animate();

  // UI
  vrmFile.addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    overlayNotice.style.display = 'none';
    await loadVRMFromFile(f);
  });

  providerSel.addEventListener('change', (e) => {
    customEndpointLabel.style.display = e.target.value === 'custom' ? 'block' : 'none';
  });

  sendBtn.addEventListener('click', onSend);
  messageInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') onSend(); });
}

async function loadVRMFromFile(file){
  try{
    const arrayBuffer = await file.arrayBuffer();
    const loader = new GLTFLoader();
    loader.parse(arrayBuffer, '', async (gltf) => {
      try{
        // three-vrm provides VRM.from or load method; try to handle both
        let _vrm;
        if (typeof VRM.from === 'function'){
          _vrm = await VRM.from(gltf);
        } else if (typeof VRMUtils !== 'undefined' && typeof VRMUtils.load === 'function'){
          _vrm = await VRMUtils.load(gltf);
        } else {
          // fallback: try 'loadVRM' global
          if (typeof window.loadVRM === 'function'){
            _vrm = await window.loadVRM(gltf);
          }
        }

        if (!_vrm){
          // try the library export 'VRM' directly (older versions)
          try{
            _vrm = await (await import('https://unpkg.com/@pixiv/three-vrm@1.0.0-beta.5/dist/three-vrm.module.js')).loadVRM(gltf);
          }catch(err){
            console.warn('loadVRM fallback failed', err);
          }
        }

        if (!_vrm){
          alert('Failed to parse VRM. The file may be unsupported by this demo.');
          return;
        }

        // Remove previous
        if (vrm){ scene.remove(vrm.scene); vrm = null; }

        vrm = _vrm;
        vrm.scene.rotation.y = Math.PI; // adjust
        scene.add(vrm.scene);

        // Setup lookAt manager if present
        try{ if (vrm.lookAt) vrm.lookAt.target = new THREE.Vector3(0, 1.4, 0); }catch(e){}

        // Save head bone for simple lookAt
        try{ headBone = vrm.humanoid?.getBoneNode('head') ?? null; }catch(e){ headBone = null; }

        // Setup mixer for animations if any
        mixer = new THREE.AnimationMixer(vrm.scene);
        if (gltf.animations && gltf.animations.length) {
          const clip = gltf.animations[0];
          mixer.clipAction(clip).play();
        }

        addChatMessage('system', 'VRM loaded — you can chat now.');
      }catch(err){ console.error(err); alert('Error loading VRM: '+err.message); }
    }, (err) => { console.error('parse error', err); alert('Failed to parse GLTF/VRM file'); });
  }catch(err){ console.error(err); alert('Could not read file: '+err.message); }
}

function resize(){
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.width || window.innerWidth;
  const h = canvas.clientHeight || canvas.height || 320;
  renderer.setSize(w, h, false);
  if (camera) camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function animate(){
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  if (mixer) mixer.update(dt);
  renderer.render(scene, camera);
}

function addChatMessage(who, text){
  const el = document.createElement('div');
  el.className = 'chatMessage ' + (who==='user' ? 'user' : (who==='ai' ? 'ai' : 'system'));
  el.textContent = text;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function onSend(){
  const text = messageInput.value.trim();
  if (!text) return;
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey){ alert('Paste an API key in the API Key field first (used from your browser).'); return; }
  addChatMessage('user', text);
  messageInput.value = '';

  addChatMessage('system', 'Thinking...');
  try{
    const provider = providerSel.value;
    let url;
    if (provider === 'openai'){
      url = 'https://api.openai.com/v1/chat/completions';
    } else {
      url = customEndpointInput.value.trim();
      if (!url) { alert('Enter custom endpoint URL'); return; }
    }

    // Build a prompt that requests a JSON-only response with chat text + actions
    const instruction = `You are an avatar controller. For the user's message, respond ONLY with a JSON object with keys: \n`+
      `\"chat\" (string) - textual reply to show, and \"actions\" (array) - each action is an object. Allowed action types: expression, look_at, play_animation, blink. Examples:\n`+
      `{\"chat\":\"Hi!\",\"actions\":[{\"type\":\"expression\",\"name\":\"Smile\",\"value\":0.8,\"duration\":1000},{\"type\":\"look_at\",\"target\":{\"x\":0,\"y\":1.4,\"z\":0},\"duration\":500}]}`;

    const messages = [
      { role: 'system', content: instruction },
      { role: 'user', content: text }
    ];

    const payload = {
      model: 'gpt-4o-mini',
      messages: messages,
      max_tokens: 400,
      temperature: 0.8
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok){
      const errText = await res.text();
      addChatMessage('system', 'AI request failed: ' + res.status + ' ' + res.statusText);
      console.error('AI error', res.status, errText);
      return;
    }

    const data = await res.json();
    // Attempt to extract text content for OpenAI-style response
    let content = '';
    if (data.choices && data.choices.length){
      content = data.choices[0].message?.content ?? '';
    } else if (data.text) {
      content = data.text;
    } else {
      content = JSON.stringify(data);
    }

    // Remove the "Thinking..." system message
    const sysMsgs = chatLog.querySelectorAll('.chatMessage.system');
    if (sysMsgs.length) sysMsgs[sysMsgs.length-1].remove();

    // Try to parse JSON from content. The model is instructed to return only JSON.
    let parsed = null;
    try{
      parsed = JSON.parse(content.trim());
    }catch(e){
      // Try to find JSON substring
      const m = content.match(/(\{[\s\S]*\})/);
      if (m) {
        try{ parsed = JSON.parse(m[1]); }catch(e2){ parsed = null; }
      }
    }

    if (!parsed){
      addChatMessage('ai', content);
      addChatMessage('system', 'AI did not return valid JSON actions.');
      return;
    }

    if (parsed.chat) addChatMessage('ai', parsed.chat);
    if (parsed.actions && Array.isArray(parsed.actions)) applyActions(parsed.actions);

  }catch(err){
    console.error(err);
    addChatMessage('system','Error: '+err.message);
  }
}

function applyActions(actions){
  for (const a of actions){
    if (!a || !a.type) continue;
    if (a.type === 'expression'){
      // set blendshape if available
      if (vrm && vrm.blendShapeProxy && typeof vrm.blendShapeProxy.setValue === 'function'){
        const name = a.name || a.expression || 'Joy';
        const val = typeof a.value === 'number' ? a.value : 1.0;
        vrm.blendShapeProxy.setValue(name, val);
        // decay after duration
        const d = a.duration ?? 800;
        setTimeout(()=>{ try{ vrm.blendShapeProxy.setValue(name, 0); }catch(e){} }, d);
      }
    } else if (a.type === 'look_at'){
      // simple head lookAt in world space relative to camera
      const t = a.target || { x:0, y:1.4, z:0 };
      if (headBone) {
        const worldTarget = new THREE.Vector3(t.x, t.y, t.z);
        headBone.lookAt(worldTarget);
      } else if (vrm && vrm.lookAt && vrm.lookAt.target){
        vrm.lookAt.target.set(t.x, t.y, t.z);
      }
    } else if (a.type === 'play_animation'){
      // If VRM has animations, try to play an animation of that name
      const name = a.name;
      if (mixer && vrm && vrm.scene){
        const clips = vrm.scene.animations || [];
        const clip = clips.find(c=>c.name === name) || clips[0];
        if (clip){ mixer.clipAction(clip).reset().play(); }
      }
    } else if (a.type === 'blink'){
      // quick blink using common blink blendshape names
      const blinkNames = ['Blink', 'blink', 'A', 'B'];
      if (vrm && vrm.blendShapeProxy){
        const name = (a.name && vrm.blendShapeProxy._blendShapeMap && vrm.blendShapeProxy._blendShapeMap[a.name]) ? a.name : blinkNames[0];
        vrm.blendShapeProxy.setValue(name, 1.0);
        setTimeout(()=>{ try{ vrm.blendShapeProxy.setValue(name, 0); }catch(e){} }, a.duration || 150);
      }
    }
  }
}
