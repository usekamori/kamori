<?php

return [
    /*
    |--------------------------------------------------------------------------
    | Kamori Server URL
    |--------------------------------------------------------------------------
    | The base URL of your self-hosted Kamori ingest server.
    */
    'url' => env('KAMORI_URL', ''),

    /*
    |--------------------------------------------------------------------------
    | Authentication Token
    |--------------------------------------------------------------------------
    | Must match INGEST_TOKEN on the Kamori server. Leave empty to disable auth.
    */
    'token' => env('INGEST_TOKEN', ''),

    /*
    |--------------------------------------------------------------------------
    | Batch Size
    |--------------------------------------------------------------------------
    | Number of events to buffer before flushing. Lower values reduce memory
    | usage at the cost of more HTTP requests.
    */
    'batch_size' => 50,
];
