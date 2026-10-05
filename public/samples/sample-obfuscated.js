// unravel demo sample — a small javascript-obfuscator-style script:
// string array + rotation + hex identifiers + control-flow flattening + dead code.
var _0x2d31 = [
  "log", "Hello from the obfuscated world!", "unravel-me", "number",
  "You clicked ", "times", "deadFnShouldGoAway", "string",
  "Secret token: ", "object"
];
(function (_0x4a11, _0x5b22) {
  var _0x6c33 = function (_0x7d44) {
    while (--_0x7d44) { _0x4a11["push"](_0x4a11["shift"]()); }
  };
  _0x6c33(++_0x5b22);
}(_0x2d31, 0x1f));
var _0x8e99 = function (_0x9faa) {
  _0x9faa = _0x9faa - 0x0;
  var _0xabbc = _0x2d31[_0x9faa];
  return _0xabbc;
};
function _0xcdde(_0xeeff, _0xf00f) {
  var _0xstate = "0";
  while (true) {
    switch (_0xstate) {
      case "0": if (typeof _0xeeff !== _0x8e99("0x3")) { _0xstate = "1"; continue; } _0xstate = "2"; continue;
      case "1": return _0x8e99("0x0"); case "2": return String(_0xeeff) + _0x8e99("0x5") + _0xf00f;
    }
    break;
  }
}
function _0xdead(_0xbeef) { return _0xbeef * 0x2 + 0x40; } // never referenced → dead
console[_0x8e99("0x0")](_0x8e99("0x1"));
var _0xcount = 0x0;
document.addEventListener(_0x8e99("0x2"), function () {
  _0xcount++;
  console[_0x8e99("0x0")](_0xcdde(_0x8e99("0x4"), _0xcount));
});
console[_0x8e99("0x0")](_0x8e99("0x8") + btoa(_0x8e99("0x7")));
