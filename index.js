// A simple TTL cache with max capacity option, ms resolution,
// autopurge, and reasonably optimized performance
// Relies on the fact that integer Object keys are kept sorted,
// and managed very efficiently by V8.

const maybeReqPerfHooks = fallback => {
  try {
    return require('perf_hooks').performance
  } catch (e) {
    return fallback
  }
}
const timeProvider = maybeReqPerfHooks(Date)
const now = () => timeProvider.now()
const isPosInt = n => n && n === Math.floor(n) && n > 0 && isFinite(n)
const isPosIntOrInf = n => n === Infinity || isPosInt(n)

class TTLCache {
  constructor({
    max = Infinity,
    ttl,
    updateAgeOnGet = false,
    noUpdateTTL = false,
    dispose,
  } = {}) {
    // {[expirationTime]: [keys]}
    this.expirations = Object.create(null)
    // {key=>val}
    this.data = new Map()
    // {key=>expiration}
    this.expirationMap = new Map()
    if (ttl !== undefined && !isPosIntOrInf(ttl)) {
      throw new TypeError(
        'ttl must be positive integer or Infinity if set'
      )
    }
    if (!isPosIntOrInf(max)) {
      throw new TypeError('max must be positive integer or Infinity')
    }
    this.ttl = ttl
    this.max = max
    this.updateAgeOnGet = updateAgeOnGet
    this.noUpdateTTL = noUpdateTTL
    if (dispose !== undefined) {
      if (typeof dispose !== 'function') {
        throw new TypeError('dispose must be function if set')
      }
      this.dispose = dispose
    }
  }

  clear() {
    const entries =
      this.dispose !== TTLCache.prototype.dispose ? [...this] : []
    this.data.clear()
    this.expirationMap.clear()
    this.expirations = Object.create(null)
    for (const [key, val] of entries) {
      this.dispose(val, key, 'delete')
    }
  }

  setTTL(key, ttl = this.ttl) {
    const current = this.expirationMap.get(key)
    if (current !== undefined) {
      // remove from the expirations list, so it isn't purged
      const exp = this.expirations[current]
      if (!exp || exp.length <= 1) {
        delete this.expirations[current]
      } else {
        this.expirations[current] = exp.filter(k => k !== key)
      }
    }

    if (ttl !== Infinity) {
      const expiration = Math.floor(now() + ttl)
      this.expirationMap.set(key, expiration)
      if (!this.expirations[expiration]) {
        const t = setTimeout(() => this.purgeStale(), ttl)
        /* istanbul ignore else - affordance for non-node envs */
        if (t.unref) t.unref()
        this.expirations[expiration] = []
      }
      this.expirations[expiration].push(key)
    } else {
      this.expirationMap.set(key, Infinity)
    }
  }

  set(
    key,
    val,
    {
      ttl = this.ttl,
      noUpdateTTL = this.noUpdateTTL,
      noDisposeOnSet = this.noDisposeOnSet,
    } = {}
  ) {
    if (!isPosIntOrInf(ttl)) {
      throw new TypeError('ttl must be positive integer or Infinity')
    }
    if (this.expirationMap.has(key)) {
      if (!noUpdateTTL) {
        this.setTTL(key, ttl)
      }
      // has old value
      const oldValue = this.data.get(key)
      if (oldValue !== val) {
        this.data.set(key, val)
        if (!noDisposeOnSet) {
          this.dispose(oldValue, key, 'set')
        }
      }
    } else {
      this.setTTL(key, ttl)
      this.data.set(key, val)
    }

    while (this.size > this.max) {
      this.purgeToCapacity()
    }

    return this
  }

  has(key) {
    return this.data.has(key)
  }

  getRemainingTTL(key) {
    const expiration = this.expirationMap.get(key)
    return expiration === Infinity
      ? expiration
      : expiration !== undefined
      ? Math.max(0, Math.ceil(expiration - now()))
      : 0
  }

  get(
    key,
    { updateAgeOnGet = this.updateAgeOnGet, ttl = this.ttl } = {}
  ) {
    const val = this.data.get(key)
    if (updateAgeOnGet) {
      this.setTTL(key, ttl)
    }
    return val
  }

  dispose(_, __) {}

  delete(key) {
    const current = this.expirationMap.get(key)
    if (current !== undefined) {
      const value = this.data.get(key)
      this.data.delete(key)
      this.expirationMap.delete(key)
      const exp = this.expirations[current]
      if (exp && exp.length <= 1) {
        delete this.expirations[current]
      } else {
        this.expirations[current] = exp.filter(k => k !== key)
      }
      this.dispose(value, key, 'delete')
      return true
    }
    return false
  }

  purgeToCapacity() {
    for (const exp in this.expirations) {
      const keys = this.expirations[exp]
      if (this.size - keys.length >= this.max) {
        for (const key of keys) {
          const val = this.data.get(key)
          this.data.delete(key)
          this.expirationMap.delete(key)
          this.dispose(val, key, 'evict')
        }
        delete this.expirations[exp]
      } else {
        const s = this.size - this.max
        for (const key of keys.splice(0, s)) {
          const val = this.data.get(key)
          this.data.delete(key)
          this.expirationMap.delete(key)
          this.dispose(val, key, 'evict')
        }
      }
      return
    }
  }

  get size() {
    return this.data.size
  }

  purgeStale() {
    const n = Math.ceil(now())
    for (const exp in this.expirations) {
      if (exp === 'Infinity' || exp > n) {
        return
      }
      for (const key of this.expirations[exp]) {
        const val = this.data.get(key)
        this.data.delete(key)
        this.expirationMap.delete(key)
        this.dispose(val, key, 'stale')
      }
      delete this.expirations[exp]
    }
  }

  *entries() {
    for (const exp in this.expirations) {
      for (const key of this.expirations[exp]) {
        yield [key, this.data.get(key)]
      }
    }
  }
  *keys() {
    for (const exp in this.expirations) {
      for (const key of this.expirations[exp]) {
        yield key
      }
    }
  }
  *values() {
    for (const exp in this.expirations) {
      for (const key of this.expirations[exp]) {
        yield this.data.get(key)
      }
    }
  }
  [Symbol.iterator]() {
    return this.entries()
  }
}

module.exports = TTLCache
