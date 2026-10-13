---
layout: home
hero:
  name: Image attributes
  image:
    src: /missing-hero.png
    alt: Hero
    onerror: heroimageonerror
    onload: heroimageonload
features:
  - title: Object icon
    icon:
      src: /missing-icon.png
      onerror: iconobjectonerror
  - title: Themed icon
    icon:
      light:
        src: /missing-light.png
        onerror: iconlightonerror
      dark:
        src: /missing-dark.png
        onerror: icondarkonerror
  - title: Wrapped icon
    icon:
      src: /missing-wrap.png
      wrap: true
      width: 24
      onerror: iconwraponerror
---
