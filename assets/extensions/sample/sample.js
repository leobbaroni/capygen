(() => {
  const result = document.getElementById('result');
  let bridge;
  let sequence = 0;
  const pending = new Map();
  const paint = (tokens) => { for (const [name, value] of Object.entries(tokens)) if (name !== 'mode') document.documentElement.style.setProperty(`--${name}`, value); };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    if (!bridge) return reject(new Error('Host bridge is not ready'));
    const requestId = `sample-${++sequence}`;
    const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error('Host request timed out')); }, 12000);
    pending.set(requestId, (reply) => { clearTimeout(timeout); reply.ok ? resolve(reply.result) : reject(new Error(reply.error.message)); });
    bridge.port.postMessage({version:1,instanceId:bridge.instanceId,nonce:bridge.nonce,requestId,method,params});
  });
  window.addEventListener('message', (event) => {
    if (bridge || event.source !== window || event.origin !== location.origin || event.data?.type !== 'capygen-extension-ready' || event.ports.length !== 1) return;
    bridge = {...event.data,port:event.ports[0]};
    bridge.port.onmessage = ({data}) => { if(data.type === 'theme.changed') paint(data.theme); else { pending.get(data.requestId)?.(data); pending.delete(data.requestId); } };
    bridge.port.start();
    document.getElementById('status').textContent = `Connected · ${bridge.grants.join(', ') || 'no capabilities granted'}`;
  });
  const bind = (id, method, params = {}) => document.getElementById(id).onclick = async () => { try { const value = await call(method, params); if(method === 'theme.subscribe') paint(value); result.textContent = JSON.stringify(value,null,2); } catch(error) { result.textContent = error.message; } };
  bind('theme','theme.subscribe'); bind('save','storage.user.set',{key:'welcome',value:'Saved locally'}); bind('read','storage.user.get',{key:'welcome'});
  bind('projects','projects.list'); bind('sessions','sessions.listPage'); bind('new','navigation.openNewSession');
})();
