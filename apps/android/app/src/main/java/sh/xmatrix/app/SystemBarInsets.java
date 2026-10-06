package sh.xmatrix.app;

record SystemBarInsets(int left, int top, int right, int bottom) {
  static SystemBarInsets resolve(
    int systemLeft,
    int systemTop,
    int systemRight,
    int systemBottom,
    int cutoutLeft,
    int cutoutTop,
    int cutoutRight,
    int cutoutBottom
  ) {
    return new SystemBarInsets(
      Math.max(systemLeft, cutoutLeft),
      Math.max(systemTop, cutoutTop),
      Math.max(systemRight, cutoutRight),
      Math.max(systemBottom, cutoutBottom)
    );
  }
}
