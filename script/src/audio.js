var Audio = (function(){
    var me = {};

    window.AudioContext = window.AudioContext||window.webkitAudioContext;

    var context;
    var masterVolume;
    var lowPassfilter;
    var i;
    var trackVolume = [];
    var trackPanning = [];
    var isRecording;
    var recordingAvailable;
    var mediaRecorder;
    var recordingChunks = [];

    if (AudioContext){
        context = new AudioContext();

        masterVolume = context.createGain();
        masterVolume.gain.value = 0.7;
        masterVolume.connect(context.destination);

        lowPassfilter = context.createBiquadFilter();
        lowPassfilter.type = "lowpass";
        lowPassfilter.frequency.value = 20000;

        lowPassfilter.connect(masterVolume);
    }

    me.init = function(){
        if (!context) return;

        var numberOfTracks = Tracker.getTrackCount();

        for (i = 0; i<numberOfTracks;i++){
            var gain = context.createGain();
            var pan = context.createStereoPanner();
            gain.gain.value = 0.7;

            // pan even channels to the left, uneven to the right
            pan.pan.value = i%2==0 ? -0.5 : 0.5;
            gain.connect(pan);
            pan.connect(lowPassfilter);
            trackVolume.push(gain);
            trackPanning.push(pan);
        }

        EventBus.on(EVENT.trackStateChange,function(event,state){
            if (typeof state.track != "undefined" && trackVolume[state.track]){
                trackVolume[state.track].gain.value = state.mute?0:0.7;
            }
        });
    };


    me.playSample = function(index,period,volume,track,effects,time){

        period = period || 428; // C-3
        track = track || Tracker.getCurrentTrack();
        time = time || 0;

        var sample = Tracker.getSample(index);

        if (sample){
            var sampleBuffer;
            var offset = 0;
            var sampleLength = 0;

            volume = typeof volume == "undefined" ? (100*sample.volume/64) : volume;

            if (sample.finetune){
                var note = periodNoteTable[period];
                if (note && note.tune){
                    var centerTune = 8;
                    var tune = 8 + sample.finetune;
                    if (tune>0 && tune<note.tune.length) period = note.tune[tune];
                }

            }
            var sampleRate = PALFREQUENCY / (period*2);

            //volume = volume * (sample.volume/64);

            var initialPlaybackRate = 1;

            if (sample.data.length) {
                sampleLength = sample.data.length;

                if (effects && effects.offset && effects.offset.value<sampleLength){
                    offset = effects.offset.value;
                    sampleLength -= offset;
                }
                // note - on safari you can't set a different samplerate?
                sampleBuffer = context.createBuffer(1, sampleLength,context.sampleRate);
                initialPlaybackRate = sampleRate / context.sampleRate;
            }else {
                // empty samples are often used to cut of the previous sample
                sampleBuffer = context.createBuffer(1, 1, sampleRate);
                offset = 0;
            }
            var buffering = sampleBuffer.getChannelData(0);
            for(i=0; i < sampleLength; i++) {
                buffering[i] = sample.data[i + offset];
            }

            var source = context.createBufferSource();
            source.buffer = sampleBuffer;

            var volumeGain = context.createGain();
            volumeGain.gain.value = volume/100; // TODO : instrument volume

            if (sample.loopStart && sample.loopRepeatLength>1){

                if (!SETTINGS.unrollLoops){
                    function createLoop(){
                        var loopLength = sample.loopRepeatLength;
                        var loopBuffer = context.createBuffer(1, loopLength, sampleRate);


                        var loopBuffering = loopBuffer.getChannelData(0);
                        for(i=0; i < loopLength; i++) {
                            loopBuffering[i] = sample.data[sample.loopStart + i];
                        }

                        var loop = context.createBufferSource();
                        loop.buffer = loopBuffer;
                        loop.connect(volumeGain);
                        loop.start(0);

                        loop.onended = function(){
                            console.error("loop end");
                            createLoop();
                        };
                        return loop;
                    }

                    //source.loop = true;
                    // in seconds ...
                    //source.loopStart = sampleRate
                    //source.loopEnd = ..

                    source.onended = function() {
                        console.error("base sample end");
                        createLoop()
                    };
                }

            }

            source.connect(volumeGain);
            volumeGain.connect(trackVolume[track]);

            source.playbackRate.value = initialPlaybackRate;
            var sourceDelayTime = 0;
            var playTime = time + sourceDelayTime;


            source.start(playTime);

            var result = {
                source: source,
                volume: volumeGain,
                startVolume: volume,
                currentVolume: volume,
                startPeriod: period,
                startPlaybackRate: initialPlaybackRate,
                sampleIndex: index,
                effects: effects
            };

            EventBus.trigger(EVENT.samplePlay,result);

            return result;
        }

        return {};
    };


    me.isRecording = function(){
        return isRecording;
    };

    me.startRecording = function(){
        if (!isRecording){

            if (context && context.createMediaStreamDestination){
                var dest = context.createMediaStreamDestination();
                mediaRecorder = new MediaRecorder(dest.stream);

                mediaRecorder.ondataavailable = function(evt) {
                    // push each chunk (blobs) in an array
                    recordingChunks.push(evt.data);
                };

                mediaRecorder.onstop = function(evt) {
                    var blob = new Blob(recordingChunks, { 'type' : 'audio/ogg; codecs=opus' });
                    saveAs(blob,"recording.opus");
                    //document.querySelector("audio").src = URL.createObjectURL(blob);
                };


                masterVolume.connect(dest);
                mediaRecorder.start();
                isRecording = true;

            }else{
                console.error("recording is not supported on this browser");
            }

        }
    };

    me.stopRecording = function(){
        if (isRecording){
            isRecording = false;
            mediaRecorder.stop();
        }
    };

    me.masterVolume = masterVolume;
    me.lowPassfilter = lowPassfilter;
    me.context = context;
    me.trackVolume = trackVolume;
    me.trackPanning = trackPanning;


    function createPingPongDelay(){

        // example of delay effect.
        //Taken from http://stackoverflow.com/questions/20644328/using-channelsplitter-and-mergesplitter-nodes-in-web-audio-api

        var delayTime = 0.12;
        var feedback = 0.3;

        var merger = context.createChannelMerger(2);
        var leftDelay = context.createDelay();
        var rightDelay = context.createDelay();
        var leftFeedback = context.createGain();
        var rightFeedback = context.createGain();
        var splitter = context.createChannelSplitter(2);


        splitter.connect( leftDelay, 0 );
        splitter.connect( rightDelay, 1 );

        leftDelay.delayTime.value = delayTime;
        rightDelay.delayTime.value = delayTime;

        leftFeedback.gain.value = feedback;
        rightFeedback.gain.value = feedback;

        // Connect the routing - left bounces to right, right bounces to left.
        leftDelay.connect(leftFeedback);
        leftFeedback.connect(rightDelay);

        rightDelay.connect(rightFeedback);
        rightFeedback.connect(leftDelay);

        // Re-merge the two delay channels into stereo L/R
        leftFeedback.connect(merger, 0, 0);
        rightFeedback.connect(merger, 0, 1);


        // Now connect your input to "splitter", and connect "merger" to your output destination.

        return{
            splitter: splitter,
            merger: merger
        }
    }


    /**

     get a new AudioNode playing at x semitones from the root note
     // used to create Chords and Arpeggio

     @param {audioNode} source: audioBuffer of the root note
     @param {Number} root: period of the root note
     @param {Number} semitones: amount of semitones from the root note
     @param {Number} finetune: finetune value of the base sample
     @return {audioNode} audioBuffer of the new note
     */
    function semiTonesFrom(source,root,semitones,finetune){
        var target;

        target = context.createBufferSource();
        target.buffer = source.buffer;

        if (semitones){
            var rootNote = periodNoteTable[root];
            var rootIndex = noteNames.indexOf(rootNote.name);
            var targetName = noteNames[rootIndex+semitones];
            if (targetName){
                var targetNote = nameNoteTable[targetName];
                if (targetNote){
                    target.playbackRate.value = (rootNote.period/targetNote.period) * source.playbackRate.value;
                }
            }
        }else{
            target.playbackRate.value = source.playbackRate.value
        }

        return target;

    }

    me.getSemiToneFrom = function(period,semitones){
        var result = period;
        if (semitones){
            var rootNote = periodNoteTable[period];
            var rootIndex = noteNames.indexOf(rootNote.name);
            var targetName = noteNames[rootIndex+semitones];
            if (targetName){
                var targetNote = nameNoteTable[targetName];
                if (targetNote){
                    result = targetNote.period;
                }
            }
        }
        return result;
    };

    return me;

}());

