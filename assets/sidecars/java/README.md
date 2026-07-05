# Java semantic sidecar (JavaGraph)

Compiler-grade Java extraction for leina, using
[JavaParser](https://github.com/javaparser/javaparser) + its symbol solver. Builds
one project model over all `.java` files so calls, overloads, generics and
inheritance resolve to the exact declaration — every emitted edge is `EXTRACTED`.

It only emits **in-repo** edges (calls/refs to the JDK or third-party jars are
dropped, never guessed), mirroring the C# sidecar.

## Run it — no JVM required

Packaged with jpackage as an app-image with a **bundled JRE**, so a user with no
Java installed can run it. leina auto-detects the binary at
`~/.leina/sidecars/java/dist/JavaGraph/bin/JavaGraph` (Windows: at the
image root, `JavaGraph.exe`); `LEINA_JAVA_SIDECAR` overrides.

## Build it

The easy path is `leina sidecar build java`, which materialises these
sources from their `.tmpl` templates and runs the exact steps below for you
(needs a JDK 17+ with `jpackage` and `curl` on PATH; set `LEINA_MAVEN_BASE`
to use a private Maven mirror). The manual steps below are kept for reference.

No Maven/Gradle required; the deps are fetched as plain jars.

```bash
cd <work>/javagraph
BASE=https://repo1.maven.org/maven2

# 1. dependencies
mkdir -p lib
curl -fsSL $BASE/com/github/javaparser/javaparser-core/3.26.4/javaparser-core-3.26.4.jar -o lib/javaparser-core-3.26.4.jar
curl -fsSL $BASE/com/github/javaparser/javaparser-symbol-solver-core/3.26.4/javaparser-symbol-solver-core-3.26.4.jar -o lib/javaparser-symbol-solver-core-3.26.4.jar
curl -fsSL $BASE/com/google/guava/guava/33.4.0-jre/guava-33.4.0-jre.jar -o lib/guava-33.4.0-jre.jar
curl -fsSL $BASE/com/google/guava/failureaccess/1.0.2/failureaccess-1.0.2.jar -o lib/failureaccess-1.0.2.jar

# 2. compile (Windows classpath separator is ';' — use ':' on Linux/macOS)
javac -cp "lib/*" -d classes src/IdGen.java src/JavaGraph.java

# 3. stage app (your jar + the dep jars on one classpath)
mkdir -p build/app && cp lib/*.jar build/app/
jar cf build/app/javagraph.jar -C classes .

# 4. package an app-image with a bundled JRE (--win-console so stdout works)
jpackage --type app-image --name JavaGraph \
  --input build/app --main-jar javagraph.jar --main-class JavaGraph \
  --add-modules "java.base,java.logging,java.xml,jdk.unsupported,java.desktop,java.sql,java.naming,java.management,java.net.http" \
  --jlink-options "--strip-debug --no-man-pages --no-header-files" \
  --win-console --dest ../dist
```

Output: `sidecars/java/dist/JavaGraph/` (launcher + bundled `runtime/`). `lib/`,
`classes/`, `build/` and `dist/` are gitignored.

Set `LEINA_SIDECAR_DEBUG=1` to print resolution counters to stderr.

## Notes / future upgrades

- The sidecar infers **source roots** from each file's `package` declaration, so
  Maven/Gradle/multi-module layouts (e.g. `module/src/main/java`) resolve. A type
  solver rooted at the repo root alone would resolve almost nothing.
- **GraalVM native-image** would collapse this to a single binary (no app-image
  folder); deferred because JavaParser's reflection needs reachability config.
- **Eclipse JDT** would raise the resolution ceiling further but is native-image
  hostile (OSGi/reflection).
