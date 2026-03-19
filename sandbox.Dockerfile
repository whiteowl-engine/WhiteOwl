FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    curl wget git ca-certificates \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user for sandbox
RUN useradd -m -s /bin/bash sandbox

# Create workspace
RUN mkdir -p /workspace && chown sandbox:sandbox /workspace

# Set working dir
WORKDIR /workspace

# Switch to non-root
USER sandbox

# Default shell
CMD ["/bin/bash"]
