import type { ToolSample } from "gui-chat-protocol";

export const samples: ToolSample[] = [
  {
    name: "Basic Shapes",
    args: {
      title: "Basic 3D Shapes",
      script: `// Basic shapes demonstration
cube { position -2 0 0 size 1 color (1 0.3 0.3) }
sphere { position 0 0 0 size 1 color (0.3 1 0.3) }
cylinder { position 2 0 0 size 0.5 1 color (0.3 0.3 1) }`,
    },
  },
  {
    name: "Circular Pattern",
    args: {
      title: "Circular Pattern",
      script: `// 12個の立方体を円形に配置

define count 12
define radius 3

for i in 1 to count {
    // 各立方体の角度を計算（2 * PI = 6.283ラジアン）
    define angle ((i / count) * 6.283)

    // 円形配置のためのX座標とZ座標を計算
    define x (cos(angle) * radius)
    define z (sin(angle) * radius)

    // グラデーションカラーを作成
    define colorValue (i / count)

    cube {
        position x 0 z
        size 0.5
        color colorValue 0.5 (1 - colorValue)
    }
}

// 中心に参考用の球体を配置
sphere {
    position 0 0 0
    size 0.3
    color 1 1 0
    opacity 0.5
}`,
    },
  },
  {
    name: "CSG Difference",
    args: {
      title: "Hollow Sphere",
      script: `// Create a hollow sphere using CSG difference
difference {
    sphere { size 2 color (1 0.5 0) }
    sphere { size 1.7 color (1 1 1) }
    cube { position 0 0 2 size 2 }
}`,
    },
  },
];
