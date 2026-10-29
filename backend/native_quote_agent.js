// Read only the requested stocks' already decoded last prices. No native calls,
// account hooks, raw packets, credentials, or trade functions.
const main = Process.getModuleByName('hexin.exe');
const stamp = main.base.add(main.base.add(0x3c).readU32() + 8).readU32();
send({type: 'build', timestamp: stamp, architecture: Process.arch});
// Profiles are injected by the Python bridge from one shared version table.
const profile = bridgeProfiles[String(stamp)];
if (!profile || Process.arch !== profile.architecture || Process.arch !== 'ia32') throw Error('unsupported_build');
const sdk = Process.getModuleByName('func_sdk_17.dll');
const convert = sdk.getExportByName('?BuildDataType@CDataType@@QAEHFPBXJ@Z');
const record = main.base.add(profile.record_rva);
const returnSite = main.base.add(profile.return_rva);
const importSlot = main.base.add(profile.convert_import_rva);
// Confirm the profiled function and indirect call still point at the expected
// SDK export before installing either hook. Unknown layouts fail closed.
if (record.readU32() !== 0x6aec8b55 || record.add(4).readU8() !== 0xff ||
    returnSite.sub(6).readU16() !== 0x15ff ||
    !returnSite.sub(4).readPointer().equals(importSlot) ||
    !importSlot.readPointer().equals(convert)) throw Error('observer_layout_mismatch');
let codes = new Set();
let active = true;
const records = new Map();
rpc.exports = {
  configure(requested, enabled) {
    codes = new Set(requested.filter(code => /^[0-9]{6}$/.test(code)).slice(0, 200));
    active = !!enabled;
  }
};
Interceptor.attach(record, {
  onEnter(args) {
    if (!active) return;
    this.thread = Process.getCurrentThreadId();
    this.previous = records.get(this.thread);
    records.delete(this.thread);
    try {
      // Native record identifier: market byte followed by six ASCII digits.
      const bytes = new Uint8Array(args[0].readByteArray(7));
      let code = '';
      for (let i = 1; i <= 6; i++) code += String.fromCharCode(bytes[i]);
      // 000001 also identifies an index: only accept SZ stock market 0x21.
      if (codes.has(code) && (!/^[03]/.test(code) || bytes[0] === 0x21)) records.set(this.thread, code);
    } catch (_) {}
  },
  onLeave() {
    if (this.thread === undefined) return;
    if (this.previous) records.set(this.thread, this.previous);
    else records.delete(this.thread);
  }
});
Interceptor.attach(convert, {
  onEnter(args) {
    if (!active || !this.returnAddress.equals(returnSite) ||
        (args[0].toInt32() & 65535) !== 0x700a) return;
    this.code = records.get(Process.getCurrentThreadId());
    if (this.code) this.valueObject = this.context.ecx;
  },
  onLeave(result) {
    if (!this.code || !active || !codes.has(this.code) || result.toInt32() <= 0) return;
    try {
      if ((this.valueObject.readU16() & 0x7000) !== 0x5000) return;
      const price = this.valueObject.add(2).readDouble();
      if (Number.isFinite(price) && price > 0 && price < 1000000)
        send({type: 'quote', code: this.code, price: price});
    } catch (_) {}
  }
});
send({type: 'ready'});
