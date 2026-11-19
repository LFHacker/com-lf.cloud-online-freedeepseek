package com.example.dsclient;

import android.os.Bundle;

import com.example.dsclient.update.AppUpdatePlugin;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 本地插件必须在 super.onCreate 之前注册：Capacitor 在 super 里才建立插件表，
        // 之后注册的插件不会被 JS 侧发现（表现为 Capacitor.Plugins.AppUpdate === undefined）。
        registerPlugin(AppUpdatePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
