export function BrandMark({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 40 44"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="m20 2 17 10v20L20 42 3 32V12Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="m3 12 17 10 17-10M20 22v20M11.5 7l17 10v10l-17-10Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function MachineArt() {
  return (
    <svg
      viewBox="0 0 280 210"
      className="machine-art"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient
          id="glass-cube"
          x1="60"
          y1="30"
          x2="215"
          y2="190"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="currentColor" stopOpacity=".15" />
          <stop offset="1" stopColor="currentColor" stopOpacity=".02" />
        </linearGradient>
      </defs>
      <g className="art-grid" stroke="currentColor" strokeOpacity=".1">
        <path d="m0 140 140-81 140 81M0 160 140-81 140 81M0 180 140-81 140 81M0 200 140-81 140 81M35 200V180l140-81M70 210v-50L210 79M105 210v-70L245 59M245 200v-20L105 99M210 210v-50L70 79M175 210v-70L35 59" />
      </g>
      <path
        d="m140 41 70 40v81l-70 41-70-41V81Z"
        fill="url(#glass-cube)"
        stroke="currentColor"
        strokeOpacity=".6"
        strokeWidth="1.2"
      />
      <path
        d="m70 81 70 41 70-41M140 122v81"
        stroke="currentColor"
        strokeOpacity=".6"
        strokeWidth="1.2"
      />
      <path
        d="m140 56 44 25-44 26-44-26Z"
        fill="currentColor"
        fillOpacity=".08"
        stroke="currentColor"
        strokeOpacity=".5"
      />
      <path
        d="m140 68 24 14-24 14-24-14Z"
        fill="currentColor"
        fillOpacity=".25"
      />
      <path
        d="m88 113 34 20v34l-34-20Z"
        stroke="currentColor"
        strokeOpacity=".6"
      />
      <path
        d="m94 129 7 4-7 7M106 144l9 5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m155 141 37-21M155 150l27-16M155 159l17-10"
        stroke="currentColor"
        strokeOpacity=".45"
        strokeWidth="2"
      />
      <circle cx="140" cy="41" r="3" fill="currentColor" />
      <circle cx="210" cy="162" r="2.5" fill="currentColor" fillOpacity=".7" />
      <path d="M140 26V12M126 20h28" stroke="currentColor" strokeOpacity=".4" />
      <circle cx="240" cy="72" r="2" fill="currentColor" fillOpacity=".4" />
      <circle cx="43" cy="114" r="2" fill="currentColor" fillOpacity=".4" />
    </svg>
  );
}
