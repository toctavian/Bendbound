// Process-local LRU: exact inputs only, bounded memory, no failures retained.
export function createCache({ttlMs=60000,maxEntries=128,maxBytes=16*1024*1024,now=Date.now}={}) {
  const entries=new Map();let bytes=0;
  function remove(key){const entry=entries.get(key);if(entry){bytes-=entry.bytes;entries.delete(key);}}
  return {
    get(key){const entry=entries.get(key);if(!entry)return null;
      if(now()-entry.created>=ttlMs){remove(key);return null;}
      entries.delete(key);entries.set(key,entry);return {value:entry.value,ageMs:now()-entry.created};},
    set(key,value){const size=Buffer.byteLength(JSON.stringify(value));remove(key);
      if(size>maxBytes)return;
      for(const [old,entry] of entries)if(now()-entry.created>=ttlMs)remove(old);
      while(entries.size>=maxEntries || bytes+size>maxBytes)remove(entries.keys().next().value);
      entries.set(key,{value,created:now(),bytes:size});bytes+=size;
    },
    clear(){entries.clear();bytes=0;},
  };
}
