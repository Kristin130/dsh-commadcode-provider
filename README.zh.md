# dsh-commandcode-provider

**语言：** [English](README.md) | 中文

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的自定义 LLM 提供方插件，将 dsh 接入 [Command Code](https://commandcode.ai) —— 是 [pi-commandcode-provider](https://github.com/patlux/pi-commandcode-provider) 在 dsh LLM 接缝上的忠实移植。

> **适配 Command Code 全部套餐，包括 $1/月的 Go 套餐。** 即使是唯一没有 Provider API 访问权限的 Go 套餐，Studio 里也给你一个 API key；这个 key 用于 CLI/agent 的鉴权登录。本插件用这个 key 走 Command Code 自己的 `/alpha/generate` 接口，**不是传统的 Provider API 协议**，所以即使套餐没有 Provider API 权限也能用。

