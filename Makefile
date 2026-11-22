# =============================================================================
# SimpleXLibTool — Theos library.mk Makefile
# Language: Makefile, file: Makefile, target: iOS arm64 / arm64e
# Credits: discord.gg/Kr2pvPfEUR | t.me/IL2CPPTool
# =============================================================================

THEOS ?= $(HOME)/theos

TARGET  := iphone:clang:14.5:14.0
ARCHS   := arm64 arm64e
DEBUG   ?= 0
FINALPACKAGE ?= 1

include $(THEOS)/makefiles/common.mk

# ------ Project ---------------------------------------------------------------
LIBRARY_NAME := LibTool

LibTool_FILES := \
    src/Core/Memory.mm        \
    src/Core/IL2CPP.mm        \
    src/Core/Scanner.mm       \
    src/Core/Hook.mm          \
    src/Lua/LuaRuntime.mm     \
    src/Lua/Bindings_ImGui.mm \
    src/Lua/Bindings_IL2CPP.mm\
    src/Lua/Bindings_Memory.mm\
    src/Lua/Bindings_Hook.mm  \
    src/UI/Overlay.mm         \
    src/UI/Tab_Tools.mm       \
    src/UI/Tab_Dumper.mm      \
    src/UI/Tab_Script.mm      \
    src/UI/Tab_Settings.mm    \
    src/UI/Tab_LibTool.mm     \
    src/Hooks/EntryPoint.mm

# Lua 5.4 — compiled as C, not C++
LibTool_FILES += \
    vendor/lua54/lapi.c   vendor/lua54/lauxlib.c vendor/lua54/lbaselib.c \
    vendor/lua54/lcode.c  vendor/lua54/lcorolib.c vendor/lua54/lctype.c  \
    vendor/lua54/ldblib.c vendor/lua54/ldebug.c   vendor/lua54/ldo.c     \
    vendor/lua54/ldump.c  vendor/lua54/lfunc.c    vendor/lua54/lgc.c     \
    vendor/lua54/linit.c  vendor/lua54/liolib.c   vendor/lua54/llex.c    \
    vendor/lua54/lmathlib.c vendor/lua54/lmem.c   vendor/lua54/loadlib.c \
    vendor/lua54/lobject.c  vendor/lua54/lopcodes.c vendor/lua54/loslib.c \
    vendor/lua54/lparser.c  vendor/lua54/lstate.c  vendor/lua54/lstring.c \
    vendor/lua54/lstrlib.c  vendor/lua54/ltable.c  vendor/lua54/ltablib.c \
    vendor/lua54/ltm.c      vendor/lua54/lundump.c vendor/lua54/lutf8lib.c\
    vendor/lua54/lvm.c      vendor/lua54/lzio.c

# Dear ImGui — C++ sources
LibTool_FILES += \
    vendor/imgui/imgui.cpp                   \
    vendor/imgui/imgui_draw.cpp              \
    vendor/imgui/imgui_tables.cpp            \
    vendor/imgui/imgui_widgets.cpp           \
    vendor/imgui/backends/imgui_impl_metal.mm

# ------ Flags -----------------------------------------------------------------
LibTool_CFLAGS := \
    -Iinclude          \
    -Ivendor/lua54     \
    -Ivendor/imgui     \
    -fobjc-arc         \
    -DLUA_COMPAT_5_3

LibTool_CCFLAGS := \
    -std=c++20         \
    -fvisibility=hidden\
    -fno-exceptions    \
    -DLUA_COMPAT_5_3

LibTool_OBJCCFLAGS := \
    -std=c++20         \
    -fobjc-arc         \
    -fvisibility=hidden

# ------ Frameworks ------------------------------------------------------------
LibTool_FRAMEWORKS := Foundation UIKit Metal MetalKit QuartzCore

# ------ Install path ----------------------------------------------------------
LibTool_INSTALL_PATH := /usr/lib

include $(THEOS_MAKE_PATH)/library.mk
