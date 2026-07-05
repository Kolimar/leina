export function makeToken(u){return u+"-t";}
class Cache{get(k){return makeToken(k);}set(k){return this.get(k);}}
export function boot(){const c=new Cache();return c.set("a");}
