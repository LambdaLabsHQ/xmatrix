package sh.xmatrix.app;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public final class SystemBarInsetsTest {
  @Test
  public void usesThreeButtonNavigationBottomInset() {
    assertEquals(
      new SystemBarInsets(0, 142, 0, 126),
      SystemBarInsets.resolve(0, 142, 0, 126, 0, 0, 0, 0)
    );
  }

  @Test
  public void updatesToGestureNavigationBottomInsetWithoutAccumulating() {
    assertEquals(
      new SystemBarInsets(0, 142, 0, 63),
      SystemBarInsets.resolve(0, 142, 0, 63, 0, 0, 0, 0)
    );
  }

  @Test
  public void keepsCutoutInsetsWhenTheyExceedSystemBars() {
    assertEquals(
      new SystemBarInsets(48, 142, 36, 63),
      SystemBarInsets.resolve(0, 142, 0, 63, 48, 80, 36, 0)
    );
  }
}
