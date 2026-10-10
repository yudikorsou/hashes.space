# Onion Monero Blockchain Explorer (xmrblocks) on Alpine Linux, for the hashes Monero Explorer Umbrel app.
#
# Why Alpine: the explorer reads the Monero Node app's LMDB blockchain directly, and LMDB keeps its locks
# (pthread mutexes) inside the shared lock.mdb file. Umbrel's Monero Node runs monerod from an Alpine
# (musl libc) image; musl and glibc lay those mutexes out differently, so a glibc (Ubuntu) explorer
# hangs forever on the first lock. Built with the same libc as monerod, both share the database safely.
#
# Build args: MONERO_TAG (match the Monero Node app), EXPLORER_REF, ARCH (x86-64 or armv8-a: never
# -march=native, which stops with "Illegal instruction" on other CPUs).

# the Alpine release Umbrel's monerod image (sethforprivacy/simple-monerod) is built on
ARG ALPINE=alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6

FROM ${ALPINE} AS build
RUN apk add --no-cache \
      bash boost-dev ca-certificates cmake curl-dev g++ git hidapi-dev libsodium-dev libusb-dev \
      linux-headers make miniupnpc-dev openssl-dev pkgconf readline-dev unbound-dev zeromq-dev \
      expat-dev libunwind-dev
ARG MONERO_TAG=v0.18.5.1
ARG EXPLORER_REF=5d9e37cb3ad5c5335c1cb1bc2e5a56981ef1b872
ARG ARCH=x86-64
ENV CFLAGS=-fPIC CXXFLAGS=-fPIC
WORKDIR /src
RUN git clone --recursive --branch "$MONERO_TAG" --depth 1 --shallow-submodules \
      https://github.com/monero-project/monero.git monero
RUN cd monero && mkdir -p build/release && cd build/release \
 && cmake -D ARCH="$ARCH" -D BUILD_64=ON -D BUILD_TESTS=OFF -D STACK_TRACE=OFF -D USE_DEVICE_TREZOR=OFF \
          -D CMAKE_BUILD_TYPE=Release ../.. \
 && make -j"$(nproc)"
RUN git clone https://github.com/moneroexamples/onion-monero-blockchain-explorer.git explorer \
 && cd explorer && git checkout "$EXPLORER_REF"
RUN cd explorer && mkdir build && cd build \
 && cmake -D MONERO_DIR=/src/monero -D CMAKE_BUILD_TYPE=Release \
          -D CMAKE_CXX_FLAGS="-fPIC -march=$ARCH" -D CMAKE_C_FLAGS="-fPIC -march=$ARCH" .. \
 && make -j"$(nproc)" \
 && strip xmrblocks

FROM ${ALPINE}
RUN apk add --no-cache \
      boost-chrono boost-date_time boost-filesystem boost-program_options boost-regex boost-serialization \
      boost-system boost-thread ca-certificates hidapi libcurl libsodium libssl3 libstdc++ libunwind \
      libusb miniupnpc readline unbound-libs zeromq \
 && adduser -D -u 1000 monero && mkdir -p /home/monero/.bitmonero && chown monero:monero /home/monero/.bitmonero
COPY --from=build /src/explorer/build/xmrblocks /home/monero/xmrblocks
COPY --from=build /src/explorer/build/templates /home/monero/templates
# every shared library xmrblocks needs must be in this image
RUN ldd /home/monero/xmrblocks && ! ldd /home/monero/xmrblocks 2>&1 | grep -q "not found"
USER monero
WORKDIR /home/monero
VOLUME /home/monero/.bitmonero
EXPOSE 8081
ENTRYPOINT ["/bin/sh", "-c"]
CMD ["./xmrblocks --enable-json-api --enable-autorefresh-option"]
