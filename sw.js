const CACHE='careerpilot-shell-v16';
const ASSETS=['./','./index.html','./manifest.json'];

self.addEventListener('install',event=>{
  event.waitUntil(
    caches.open(CACHE)
      .then(c=>c.addAll(ASSETS))
      .then(()=>self.skipWaiting())
  );
});

self.addEventListener('activate',event=>{
  event.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(
        keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))
      ))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET') return;

  const url=new URL(event.request.url);
  const isHTML=event.request.mode==='navigate' ||
    url.pathname.endsWith('/') ||
    url.pathname.endsWith('/index.html');

  if(isHTML){
    event.respondWith(
      fetch(event.request)
        .then(res=>{
          const copy=res.clone();
          caches.open(CACHE).then(c=>c.put('./index.html',copy)).catch(()=>{});
          return res;
        })
        .catch(()=>caches.match('./index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached=>
      cached || fetch(event.request).then(res=>{
        const copy=res.clone();
        caches.open(CACHE).then(c=>c.put(event.request,copy)).catch(()=>{});
        return res;
      }).catch(()=>cached)
    )
  );
});